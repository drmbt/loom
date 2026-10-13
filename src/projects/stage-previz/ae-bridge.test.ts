import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import { loadProject } from "../../domain/project/index.ts";
import { projectFps, projectRange } from "../../domain/types/graph.ts";
import { buildCheckedProjectFile } from "../../examples/checked-project.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * VN114 — stage-previz-13: -12 fed by After Effects renders instead of Syphon. StageFeeds@2's
 * live bank is two timeline-locked movies, `movie_dsFeed` on the DS projector and ONE
 * `movie_sidesFeed` on both sides (stage left flipped after its switch); FX keeps its Syphon on
 * a Source of its own that opens on the test pattern. The song is `audiofile_reference`, the
 * session runs at 30 fps for exactly the song's length, and it opens on the single view.
 * Read back where the consumers read it: the switch passes' uniforms and bound textures.
 */
const FILE = "projects/stage-previz/stage-previz-13.loom.json";
const SONG_SECONDS = 144.733;
const text = readFileSync(FILE, "utf8");
const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
const loaded = loadProject(text, { nodes: system.nodes, components: system.components });
if (!loaded.ok) throw new Error(`stage-previz-13 did not load: ${loaded.reason}`);
const { document } = loaded;

/** The Source fader at `source` (the Panel's `slider_source` publishes it as channel `source`). */
function switches(source: number) {
  const channels: ChannelResolver = (name, context) => (context.definition.type === "number" && name.split(":")[1] === "source" ? source : undefined);
  const plan = compileGraph({ graph: document.graph, settings: document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components: system.components.view(), resolution: { channels } });
  if (!plan.ok) throw new Error("stage-previz-13 did not compile");
  /** What each projector's switch shows: the resource bound at the index it selects. */
  const shown = (nodeId: string): string => {
    const pass = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === nodeId) as { uniforms: { index: number }; textures: Array<{ binding: string; resourceId: string }> } | undefined;
    if (pass === undefined) throw new Error(`no pass for ${nodeId}`);
    return pass.textures.find((texture) => texture.binding === `inputTexture${pass.uniforms.index}`)!.resourceId;
  };
  const flip = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === "stageFeeds/flipSL") as { textures: Array<{ resourceId: string }> } | undefined;
  return { DS: shown("stageFeeds/feedDS"), SL: shown("stageFeeds/feedSL"), SR: shown("stageFeeds/feedSR"), FX: shown("stageFeeds/feedFX"), flipReads: flip?.textures[0]?.resourceId };
}

describe("stage-previz-13: After Effects renders on the projectors", () => {
  it("loads unchanged and saves back byte for byte", () => {
    expect(loaded.changed).toBe(false);
    expect(buildCheckedProjectFile({ document, components: loaded.components, now: () => document.updatedAt }).text).toBe(text);
  });

  it("StageFeeds is version 2 and the instance is pinned to it; -12 keeps version 1", () => {
    expect(document.graph.nodes["stageFeeds"]!.type).toBe("component:stageFeeds@2");
    expect(loaded.components.find((entry) => entry.componentId === "stageFeeds")!.version).toBe(2);
    const twelve = JSON.parse(readFileSync("projects/stage-previz/stage-previz-12.loom.json", "utf8")) as { componentLibrary: { components: Array<{ componentId: string; version: number }> } };
    expect(twelve.componentLibrary.components.find((entry) => entry.componentId === "stageFeeds")!.version).toBe(1);
  });

  it("the feeds are two timeline-locked movies on the AE renders, and no Syphon In is left on a projector", () => {
    const feeds = loaded.components.find((entry) => entry.componentId === "stageFeeds")!;
    const byLabel = (label: string) => Object.values(feeds.graph.nodes).find((entry) => entry.label === label);
    for (const [label, file] of [["movie_dsFeed", "media/ae-bridge/DS.mp4"], ["movie_sidesFeed", "media/ae-bridge/SIDES.mp4"]] as const) {
      const movie = byLabel(label);
      expect(movie?.type, label).toBe("movieFileIn");
      expect(movie!.parameters).toMatchObject({ file, playMode: "timeline" });
    }
    expect(Object.values(feeds.graph.nodes).filter((entry) => entry.type === "syphonIn").map((entry) => entry.label)).toEqual(["syphonin_FX"]);
  });

  it("the Panel opens on the renders: DS shows movie_dsFeed, both sides show the ONE movie_sidesFeed, stage left through its flip", () => {
    const slider = Object.values(document.graph.nodes).find((entry) => entry.label === "slider_source")!;
    expect(slider.parameters["value"]).toBe(0);
    const shown = switches(0);
    expect(shown.DS).toBe("target:stageFeeds/dsFeed:out");
    expect(shown.SR).toBe("target:stageFeeds/sidesFeed:out");
    expect(shown.SL).toBe("target:stageFeeds/sidesFeed:out");
    expect(shown.flipReads).toBe("target:stageFeeds/feedSL:out");
  });

  it("FX is off the Source fader: it opens on its test pattern whatever the projectors show", () => {
    expect(switches(0).FX).toBe("target:stageFeeds/testFX:out");
    expect(switches(2).FX).toBe("target:stageFeeds/testFX:out");
    // and the fader still moves the projectors off the renders
    expect(switches(1).DS).toBe("target:stageFeeds/testVideo:out");
  });

  it("the song is the timeline's reference: audiofile_reference, locked, declared 147.99 BPM from 0.029 s in 4/4", () => {
    const song = Object.values(document.graph.nodes).filter((entry) => entry.type === "audioFileIn");
    expect(song.map((entry) => entry.label)).toEqual(["audiofile_reference"]);
    expect(song[0]!.parameters).toMatchObject({ playMode: "timeline", tempoMode: "declared", bpm: 147.99, beatOffset: 0.029, beatsPerBar: 4 });
    expect(String(song[0]!.parameters["file"])).toMatch(/^media\/ae-bridge\//);
  });

  it("the session is the song's length at 30 fps", () => {
    expect(projectFps(document.settings)).toBe(30);
    const range = projectRange(document.settings);
    expect(range.start).toBe(0);
    expect(range.end + 1).toBe(Math.round(SONG_SECONDS * 30));
  });

  it("opens on the single view, dual and quad off", () => {
    expect(["layerSingle", "layerDual", "layerQuad"].map((id) => document.graph.nodes[id]!.ui?.bypassed === true)).toEqual([false, true, true]);
  });
});
