import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import { loadProject } from "../../domain/project/index.ts";
import { serializeProjectDocument } from "../../domain/project/serialize.ts";
import type { GraphDocument, ProjectDocument } from "../../domain/types/graph.ts";
import { edge, node } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { stageDocument } from "./document.ts";
import { AREAS, SHOT_ORDER, type AreaFacts, type StageFacts } from "./facts.ts";
import { beamShader } from "./haze.ts";
import { projectorMatrix } from "../../domain/geometry/camera.ts";
import { FT, applyRig } from "./rig.ts";

/**
 * Stage previz — the session as the app loads and compiles it, from facts shaped like the
 * Blender export's (no GLB needed: compilation sizes meshes from the measured counts).
 */
const FACTS: StageFacts = {
  glbUrl: "media/stage-previz/stage.glb",
  areas: Object.fromEntries(AREAS.map((area) => [area, {
    select: `${area}.*`, vertices: 960, triangles: 640, topY: 9.3,
    parts: area === "rig" ? "1:ds_truss 2:proj_DS 3:proj_SL 4:proj_SR" : "",
    partTable: new Map(area === "rig"
      ? [["ds_truss", { index: 1, pivot: [0, 9.28, 1.0218] }], ["proj_DS", { index: 2, pivot: [0, 9.28, 1.0218] }],
        ["proj_SL", { index: 3, pivot: [8.15, 8.55, -0.15] }], ["proj_SR", { index: 4, pivot: [-8.15, 8.55, -0.15] }]]
      : []),
  } satisfies AreaFacts])) as unknown as StageFacts["areas"],
  projectors: {
    // As layout.py's side_rig derives them: over the downstage strip's middle, crossed, keystoned
    // square, 16' deep, the far edge on the far deck edge; rolled to portrait.
    SR: { name: "SR", eye: [-8.15, 8.55, 2.3152], lookAt: [0.5076, 1.4, 2.3152], throwRatio: 1.2951, aspect: 1.7778, keystoneH: 25.0548 },
    SL: { name: "SL", eye: [8.15, 8.55, 2.3152], lookAt: [-0.5076, 1.4, 2.3152], throwRatio: 1.2951, aspect: 1.7778, keystoneH: 25.0548 },
    // As the GLB measures it: on its 4' truss, 16' from the scrim at zero tilt, tilted onto the canvas centre.
    DS: {
      name: "DS", eye: [0, 8.8811, 0.6752], lookAt: [0, 6.15, -4.35], throwRatio: 0.37, aspect: 1.7778, keystoneH: 0,
      mount: { pivot: [0, 9.28, 1.0218], forward: 0.495, drop: 0.185, restTilt: 28.523, curtainZ: -4.35 },
    },
  },
  shots: SHOT_ORDER.map((name, index) => ({ name, eye: [index, 2, 15], lookAt: [0, 4, 0], fov: 40 + index })),
  deckTop: 1.4,
};

function compiled(values: Readonly<Record<string, number>> = {}, document: ProjectDocument = stageDocument(FACTS)) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
  const loaded = loadProject(serializeProjectDocument(document), { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`);
  // A channel arrives as `<name>:<channel>`. A fader is named `slider_<role>` and publishes its role as its channel (T1593b), so values are keyed by the channel.
  const channels: ChannelResolver = (name, context) => (context.definition.type === "number" ? (values[name.split(":")[1] ?? name] ?? 0.5) : undefined);
  const plan = compileGraph({
    graph: loaded.document.graph,
    settings: loaded.document.settings,
    registry: system.nodes,
    capabilities: TIER_B_CAPABILITIES,
    components: system.components.view(),
    resolution: { channels },
  });
  return { plan, graph: loaded.document.graph };
}

const into = (graph: GraphDocument, nodeId: string, portId: string) =>
  Object.values(graph.edges)
    .filter((entry) => entry.target.nodeId === nodeId && entry.target.portId === portId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((entry) => entry.source.nodeId);

/** The deck's top in an export before the one `FACTS` stands for. */
const EARLIER_DECK_TOP = 1.1;

/**
 * A session as the app saved it after its owner rebuilt the FX feed by hand, which is what
 * `projects/stage-previz/stage-previz-7.loom.json` is: the FX Syphon is a node the app made
 * (a minted id, the name `syphonin_FX`, its server chosen), it reaches the switch through a
 * Transform of the owner's, and all three wires into the switch carry the app's ids. The app
 * has measured the meshes and written what it found on them, and the beams still hold the
 * deck height of an earlier export.
 */
function savedByHand(): ProjectDocument {
  const built = stageDocument(FACTS);
  const generated = new Set(["e-syphonFX-feedFX", "e-testFX-feedFX", "e-fxMap-feedFX"]);
  const nodes = Object.fromEntries(Object.entries(built.graph.nodes).filter(([id]) => id !== "syphonFX"));
  const edges = Object.fromEntries(Object.entries(built.graph.edges).filter(([id]) => !generated.has(id)));
  nodes["nd_fx"] = { ...built.graph.nodes["syphonFX"]!, id: "nd_fx", parameters: { source: "Arena - FX" } };
  nodes["nd_trim"] = node("nd_trim", "transform", [-4250, 3920], {}, { label: "transform_trim" });
  for (const wire of [
    edge("ed_1", ["nd_fx", "out"], ["nd_trim", "input"]),
    edge("ed_2", ["nd_trim", "out"], ["feedFX", "inputs"], 0),
    edge("ed_3", ["testFX", "out"], ["feedFX", "inputs"], 1),
    edge("ed_4", ["fxMap", "out"], ["feedFX", "inputs"], 2),
  ]) {
    edges[wire.id] = wire;
  }
  for (const id of ["meshRig", "meshDeck", "meshStrobe", "meshStage"]) nodes[id] = { ...nodes[id]!, parameters: { ...nodes[id]!.parameters, clipFrames: 0, clips: "", joints: "" } };
  for (const id of ["beamSR", "beamSL", "beamDS"]) nodes[id] = { ...nodes[id]!, parameters: { ...nodes[id]!.parameters, floorY: EARLIER_DECK_TOP } };
  return { ...built, graph: { ...built.graph, nodes, edges } };
}

describe("stage previz session", () => {
  it("loads and compiles with no errors, with every pass the haze needs", () => {
    const { plan } = compiled();
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    const passNodes = new Set(plan.passes.map((pass) => ("nodeId" in pass ? pass.nodeId : undefined)));
    for (const id of ["stage", "shadowSR", "shadowSL", "shadowDS", "beamSR", "beamSL", "beamDS", "atmosphere", "flipSL"]) expect(passNodes).toContain(id);
  });

  it("flips the stage-left feed horizontally, and only that one, into both its throw and its beam", () => {
    const { graph } = compiled();
    expect(graph.nodes["flipSL"]?.parameters).toMatchObject({ flipx: true, flipy: false });
    expect(into(graph, "projSL", "cookie")).toEqual(["flipSL"]);
    expect(into(graph, "beamSL", "input")).toEqual(["flipSL"]);
    expect(into(graph, "flipSL", "input")).toEqual(["feedSL"]);
    expect(into(graph, "projSR", "cookie")).toEqual(["feedSR"]);
    expect(into(graph, "projDS", "cookie")).toEqual(["feedDS"]);
  });

  it("puts Syphon on input 0 of every feed switch, the test content on 1 and the grid on 2, all on one Source control", () => {
    const { graph } = compiled();
    expect(into(graph, "feedSR", "inputs")).toEqual(["syphonSR", "testBeams", "testGrid"]);
    expect(into(graph, "feedSL", "inputs")).toEqual(["syphonSL", "testBeams", "testGrid"]);
    expect(into(graph, "feedDS", "inputs")).toEqual(["syphonDS", "testVideo", "testGrid"]);
    for (const feed of ["feedSR", "feedSL", "feedDS"]) {
      expect(graph.nodes[feed]?.parameters["index"]).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('slider_source').chan.source" } } });
    }
  });

  it("chains the beams so the composite sees all three, each beam reading the camera depth and its own projector's depth", () => {
    const { graph } = compiled();
    expect(into(graph, "beamSR", "more")).toEqual(["stage", "shadowSR"]);
    expect(into(graph, "beamSL", "more")).toEqual(["stage", "shadowSL", "beamSR"]);
    expect(into(graph, "beamDS", "more")).toEqual(["stage", "shadowDS", "beamSL"]);
    expect(into(graph, "atmosphere", "more")).toEqual(["stage", "beamDS", "drapeDepth"]);
  });

  it("compiles at every Source and Shot position", () => {
    for (const source of [0, 1, 2]) {
      for (const shot of [0, 1, 2, 3, 4]) {
        const { plan } = compiled({ source, shot });
        expect(plan.diagnostics.filter((entry) => entry.severity === "error"), `source ${source}, shot ${shot}`).toEqual([]);
      }
    }
  });

  it("VN12: the DS truss offset slides the lens by exactly its feet, and the tilt turns it about the clamp", () => {
    const mount = FACTS.projectors.DS.mount!;
    const lens = (values: Record<string, number>) => {
      const { plan } = compiled(values);
      const pass = plan.passes.find((entry) => "uniforms" in entry && entry.uniforms !== undefined && "projector2Pos" in entry.uniforms);
      const position = (pass as { uniforms: Record<string, readonly number[]> } | undefined)?.uniforms["projector2Pos"];
      if (position === undefined) throw new Error("no render pass carries the DS projector");
      return [position[0] ?? NaN, position[1] ?? NaN, position[2] ?? NaN] as const;
    };
    const rest = lens({ dsOffset: 0, dsTilt: mount.restTilt });
    expect(rest[1]).toBeCloseTo(FACTS.projectors.DS.eye[1], 3);
    expect(rest[2]).toBeCloseTo(FACTS.projectors.DS.eye[2], 3);
    const back = lens({ dsOffset: 10, dsTilt: mount.restTilt });
    expect(back[2] - rest[2]).toBeCloseTo(10 * FT, 5);
    expect(back[1]).toBeCloseTo(rest[1], 5);
    const level = lens({ dsOffset: 0, dsTilt: 0 });
    expect(level[1]).toBeCloseTo(mount.pivot[1] - mount.drop, 5);
    expect(level[2]).toBeCloseTo(mount.pivot[2] - mount.forward, 5);
    // 16' of throw at zero tilt, lens to scrim.
    expect((level[2] - mount.curtainZ) / FT).toBeCloseTo(16, 1);
  });

  it("VN12: one Side tilt fader re-aims both side projectors along their own pan line, onto the deck", () => {
    // Read where it is consumed: each beam pass in the haze takes its projector's aim and lens.
    const beam = (name: "SR" | "SL", values: Record<string, number>) => {
      const { plan } = compiled(values);
      const pass = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === `beam${name}`) as { uniforms?: Record<string, number | readonly number[]> } | undefined;
      if (pass?.uniforms === undefined) throw new Error(`no beam${name} pass`);
      return { aim: pass.uniforms["lensAim"] as readonly number[], throwRatio: pass.uniforms["throwRatio"] as number };
    };
    for (const name of ["SR", "SL"] as const) {
      const { eye, lookAt } = FACTS.projectors[name];
      const restTilt = (Math.atan2(eye[1] - FACTS.deckTop, Math.hypot(lookAt[0] - eye[0], lookAt[2] - eye[2])) * 180) / Math.PI;
      const rest = beam(name, { sideTilt: restTilt, sideThrow: 1.8 }).aim;
      expect(rest[0]).toBeCloseTo(lookAt[0], 3);
      expect(rest[2]).toBeCloseTo(lookAt[2], 3);
      for (const tilt of [30, 75]) {
        const { aim, throwRatio } = beam(name, { sideTilt: tilt, sideThrow: 1.2 });
        expect(aim[1]).toBeCloseTo(FACTS.deckTop, 5);
        const across = Math.hypot((aim[0] ?? 0) - eye[0], (aim[2] ?? 0) - eye[2]);
        expect(across).toBeCloseTo((eye[1] - FACTS.deckTop) / Math.tan((tilt * Math.PI) / 180), 3);
        // same pan line as at rest (the expressions carry it at 4 decimals: ~1 mm at 10 m)
        expect(Math.atan2((aim[2] ?? 0) - eye[2], (aim[0] ?? 0) - eye[0])).toBeCloseTo(Math.atan2(lookAt[2] - eye[2], lookAt[0] - eye[0]), 3);
        expect(throwRatio).toBeCloseTo(1.2, 6);
      }
    }
  });

  it("VN12: upgrading a saved session keeps its fader values and its own settings, and adds the rig once", () => {
    const saved = stageDocument(FACTS);
    const edited = {
      ...saved,
      graph: {
        ...saved.graph,
        nodes: {
          ...saved.graph.nodes,
          dsTilt: { ...saved.graph.nodes["dsTilt"]!, parameters: { ...saved.graph.nodes["dsTilt"]!.parameters, value: 12 } },
          syphonSR: { ...saved.graph.nodes["syphonSR"]!, parameters: { source: "info.v002.Syphon.TEST" } },
          projSL: { ...saved.graph.nodes["projSL"]!, parameters: { ...saved.graph.nodes["projSL"]!.parameters, shiftY: 0.051 } },
        },
      },
    };
    const upgraded = applyRig(edited, FACTS);
    expect(upgraded.graph.nodes["dsTilt"]!.parameters["value"]).toBe(12);
    expect(upgraded.graph.nodes["syphonSR"]!.parameters["source"]).toBe("info.v002.Syphon.TEST");
    expect(upgraded.graph.nodes["projSL"]!.parameters["shiftY"]).toBe(0.051); // a lens shift set by hand stays
    expect(String(upgraded.graph.nodes["stage"]!.parameters["scenes"]).split(" ").filter((name) => name === "geometry_rig")).toHaveLength(1);
    const board = JSON.parse(String(upgraded.graph.nodes["desk"]!.parameters["board"])) as { items: Array<{ label?: string; member?: string }> };
    expect(board.items.filter((item) => item.label === "Projectors")).toHaveLength(1);
    expect(board.items.filter((item) => item.member === "slider_dsOffset")).toHaveLength(1);
  });

  it("VNB8: a kernel fed by a mesh follows the mesh's measured size, so a re-measured GLB still compiles", () => {
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
    const loaded = loadProject(serializeProjectDocument(stageDocument(FACTS)), { nodes: system.nodes });
    if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`);
    const graph = structuredClone(loaded.document.graph);
    // what the app's loader writes when the export on disk has changed since the session was built
    for (const mesh of ["meshKabuki", "meshTalent", "meshRig"]) graph.nodes[mesh] = { ...graph.nodes[mesh]!, parameters: { ...graph.nodes[mesh]!.parameters, vertices: 1234 } };
    const plan = compileGraph({
      graph,
      settings: loaded.document.settings,
      registry: system.nodes,
      capabilities: TIER_B_CAPABILITIES,
      components: system.components.view(),
      resolution: { channels: () => undefined },
    });
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("one Side roll fader turns both side projectors to portrait, mirrored, in the haze and on the set", () => {
    const spin = (name: "SR" | "SL", values: Record<string, number>) => {
      const { plan } = compiled(values);
      const pass = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === `beam${name}`) as { uniforms?: Record<string, number> } | undefined;
      return pass?.uniforms?.["spin"];
    };
    expect(spin("SR", { sideRoll: 90 })).toBeCloseTo(90, 6);
    expect(spin("SL", { sideRoll: 90 })).toBeCloseTo(-90, 6);
    expect(spin("SR", { sideRoll: 30 })).toBeCloseTo(30, 6);
    expect(spin("SL", { sideRoll: 30 })).toBeCloseTo(-30, 6);
  });

  it("the scrim and the kabuki draw additively, so projector light carries on through both, in a material on the Scrim fader", () => {
    const { graph, plan } = compiled();
    for (const drape of ["geoCurtain", "geoKabuki"]) {
      expect(graph.nodes[drape]!.parameters["blend"]).toBe("additive");
      expect(graph.nodes[drape]!.parameters["material"]).toBe("material_drape");
    }
    expect(graph.nodes["matDrape"]!.parameters["color"]).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('slider_scrim').chan.scrim" } } });
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("the haze composite fades the drapes by their OWN distance: a depth-only render of them, opaque, from the view", () => {
    // Additive drapes write no depth, so the composite's scene depth runs on through them to
    // whatever is behind; the drapes' own depth arrives as the composite's third More.
    const { graph, plan } = compiled();
    const depth = graph.nodes["drapeDepth"]!;
    expect(depth.parameters).toMatchObject({ scenes: "geometry_curtainDepth geometry_kabukiDepth", camera: "camera_view", depthOutput: true });
    expect(into(graph, "geoCurtainDepth", "points")).toEqual(["meshCurtain"]);
    expect(into(graph, "geoKabukiDepth", "points")).toEqual(["kabukiFly"]); // it flies with the kabuki
    for (const id of ["geoCurtainDepth", "geoKabukiDepth"]) expect(graph.nodes[id]!.parameters["blend"] ?? "normal").not.toBe("additive");
    // nothing else draws them: the stage and the projectors' occluder views keep the additive drapes
    for (const render of ["stage", "shadowSR", "shadowSL", "shadowDS"]) {
      expect(String(graph.nodes[render]!.parameters["scenes"]).split(" ")).not.toContain("geoCurtainDepth");
    }
    const source = String(graph.nodes["atmosphere"]!.parameters["source"]);
    expect(source).toContain("var inputTexture3");
    expect(source).toContain("min(sceneDistance(cam, ray, uv, params.reach), drapeDistance(cam, ray, uv, params.reach))");
    expect(plan.passes.some((pass) => "nodeId" in pass && pass.nodeId === "drapeDepth")).toBe(true);
  });

  it("the Orbit fader turns the view about the shot's look-at, level, and the haze sees from where the view is", () => {
    // Read where it is consumed: every beam pass marches from the view's eye toward its aim.
    const view = (values: Record<string, number>) => {
      const { plan } = compiled(values);
      const pass = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === "beamSR") as { uniforms?: Record<string, readonly number[]> } | undefined;
      if (pass?.uniforms === undefined) throw new Error("no beamSR pass");
      return { eye: pass.uniforms["eye"]!, aim: pass.uniforms["aim"]! };
    };
    for (const shot of [0, 3]) {
      const preset = view({ shot, orbit: 0, zoom: 0 });
      const { eye, lookAt } = FACTS.shots[shot]!;
      expect([...preset.eye]).toEqual(eye.map((value) => expect.closeTo(value, 5)));
      expect([...preset.aim]).toEqual(lookAt.map((value) => expect.closeTo(value, 5)));
      // 180° in either direction: the far side of the look-at, at the same height, aiming at the same point
      for (const orbit of [180, -180]) {
        const behind = view({ shot, orbit, zoom: 0 });
        expect(behind.eye[0]).toBeCloseTo(2 * lookAt[0] - eye[0], 4);
        expect(behind.eye[1]).toBeCloseTo(eye[1], 6);
        expect(behind.eye[2]).toBeCloseTo(2 * lookAt[2] - eye[2], 4);
        expect([...behind.aim]).toEqual([...preset.aim]);
      }
      // a quarter turn keeps the distance to the look-at
      const quarter = view({ shot, orbit: 90, zoom: 0 });
      const reach = (point: readonly number[]) => Math.hypot((point[0] ?? 0) - lookAt[0], (point[2] ?? 0) - lookAt[2]);
      expect(reach(quarter.eye)).toBeCloseTo(reach(eye), 4);
      expect(quarter.eye[0]).not.toBeCloseTo(eye[0], 1);
    }
  });

  it("Orbit and Zoom get a row of their own under Shot, nothing on the panel overlaps, and upgrading lays it out once", () => {
    type Board = { items: Array<{ member?: string; label?: string; rect: { x: number; y: number; w: number; h: number } }> };
    const boardOf = (document: ReturnType<typeof stageDocument>) => JSON.parse(String(document.graph.nodes["desk"]!.parameters["board"])) as Board;
    const board = boardOf(stageDocument(FACTS));
    const at = (member: string) => board.items.find((item) => item.member === member)?.rect;
    expect(at("slider_orbit")?.y).toBe(at("slider_shot")!.y + 1);
    expect(at("slider_zoom")?.y).toBe(at("slider_orbit")?.y);
    expect(at("slider_source")?.y).toBe(at("slider_shot")?.y);
    for (const [index, a] of board.items.entries()) {
      for (const b of board.items.slice(index + 1)) {
        const apart = a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x || a.rect.y + a.rect.h <= b.rect.y || b.rect.y + b.rect.h <= a.rect.y;
        expect(apart, `${a.member ?? a.label} and ${b.member ?? b.label} overlap`).toBe(true);
      }
    }
    for (const member of ["slider_orbit", "slider_zoom", "slider_sideKeyH", "slider_sideKeyV"]) expect(board.items.filter((item) => item.member === member)).toHaveLength(1);
    expect(boardOf(applyRig(applyRig(stageDocument(FACTS), FACTS), FACTS)).items).toEqual(board.items);
  });

  it("the Zoom fader moves the view along its line to the look-at, by feet, never through it", () => {
    const view = (values: Record<string, number>) => {
      const { plan } = compiled(values);
      const pass = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === "beamSR") as { uniforms?: Record<string, readonly number[]> } | undefined;
      return pass!.uniforms!["eye"]!;
    };
    const { eye, lookAt } = FACTS.shots[0]!;
    const away = [eye[0] - lookAt[0], eye[1] - lookAt[1], eye[2] - lookAt[2]];
    const reach = Math.hypot(away[0]!, away[1]!, away[2]!);
    for (const [zoom, expected] of [[10, reach + 10 * FT], [-20, reach - 20 * FT], [-80, 0.05 * reach]] as const) {
      const moved = view({ shot: 0, orbit: 0, zoom });
      const now = [moved[0]! - lookAt[0], moved[1]! - lookAt[1], moved[2]! - lookAt[2]];
      expect(Math.hypot(now[0]!, now[1]!, now[2]!)).toBeCloseTo(expected, 4);
      for (const axis of [0, 1, 2]) expect(now[axis]! / expected).toBeCloseTo(away[axis]! / reach, 5); // same line
    }
  });

  it("one FX feed drives the pixel lines and the strobes: Syphon, test and the pixel-map template on the Source switch", () => {
    const { graph, plan } = compiled({ source: 1 });
    expect(into(graph, "feedFX", "inputs")).toEqual(["syphonFX", "testFX", "fxMap"]);
    expect(graph.nodes["feedFX"]!.parameters["index"]).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('slider_source').chan.source" } } });
    expect(graph.nodes["fxMap"]!.parameters["file"]).toBe("media/stage-previz/fx-pixel-map.png");
    // both emitter materials read the feed through the surface uv the GLB bakes per fixture
    expect(into(graph, "matLed", "albedo")).toEqual(["feedFX"]);
    expect(into(graph, "matStrobe", "albedo")).toEqual(["feedFX"]);
    expect(graph.nodes["matLed"]!.parameters["color"]).toMatchObject({ bindings: { expression: { source: "op('slider_leds').chan.leds * 2" } } });
    expect(graph.nodes["matStrobe"]!.parameters["color"]).toMatchObject({ bindings: { expression: { source: "op('slider_strobes').chan.strobes * 4" } } });
    expect(into(graph, "geoStrobe", "points")).toEqual(["meshStrobe"]);
    expect(graph.nodes["meshStrobe"]!.parameters["select"]).toBe("strobe.*");
    // the strobes draw in the house view; like the LEDs they are light, not occluders
    expect(String(graph.nodes["stage"]!.parameters["scenes"]).split(" ")).toEqual(expect.arrayContaining(["geometry_led", "geometry_strobe"]));
    for (const render of ["shadowSR", "shadowSL", "shadowDS", "drapeDepth"]) expect(String(graph.nodes[render]!.parameters["scenes"]).split(" ")).not.toContain("geoStrobe");
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(plan.passes.some((pass) => "nodeId" in pass && pass.nodeId === "testFX")).toBe(true);
  });

  it("upgrading keeps the Syphon server chosen for the FX feed, and adds the feed once", () => {
    const saved = stageDocument(FACTS);
    const nodes = { ...saved.graph.nodes, syphonFX: { ...saved.graph.nodes["syphonFX"]!, parameters: { source: "Arena - FX" } } };
    const upgraded = applyRig({ ...saved, graph: { ...saved.graph, nodes } }, FACTS).graph;
    expect(upgraded.nodes["syphonFX"]!.parameters["source"]).toBe("Arena - FX");
    expect(String(upgraded.nodes["stage"]!.parameters["scenes"]).split(" ").filter((name) => name === "geometry_strobe")).toHaveLength(1);
    expect(Object.values(upgraded.edges).filter((wire) => wire.target.nodeId === "feedFX")).toHaveLength(3);
  });

  it("upgrading refreshes the haze shaders this project generated, and leaves a hand-written one alone", () => {
    const saved = stageDocument(FACTS);
    const stale = "// Stage previz — old beam (generated by src/projects/stage-previz/haze.ts).\n";
    const nodes = { ...saved.graph.nodes };
    for (const id of ["beamSR", "beamSL"]) nodes[id] = { ...nodes[id]!, parameters: { ...nodes[id]!.parameters, source: stale, density: 0.25 } };
    nodes["beamDS"] = { ...nodes["beamDS"]!, parameters: { ...nodes["beamDS"]!.parameters, source: "// mine" } };
    const upgraded = applyRig({ ...saved, graph: { ...saved.graph, nodes } }, FACTS).graph.nodes;
    expect(upgraded["beamSR"]!.parameters["source"]).toBe(beamShader("SR", false));
    expect(upgraded["beamSL"]!.parameters["source"]).toBe(beamShader("SL", true));
    expect(upgraded["beamSL"]!.parameters["density"]).toBe(0.25);
    expect(upgraded["beamDS"]!.parameters["source"]).toBe("// mine");
  });

  it("the crossed side images: keystoned square, 16' deep, the far edge on the far deck edge, overlapping in the middle", () => {
    // What each beam pass in the haze actually throws — lens, aim, roll, throw, keystone — through
    // camera.ts's projectorMatrix, the projector's own matrix: where its image corners land on the deck.
    const values = { sideTilt: 39.5521, sideThrow: 1.2951, sideRoll: 90, sideKeyH: 25.0548, sideKeyV: 0 };
    const { plan } = compiled(values);
    const onDeck = (name: "SR" | "SL", corners: ReadonlyArray<readonly [number, number]>) => {
      const pass = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === `beam${name}`) as { uniforms?: Record<string, number | readonly number[]> } | undefined;
      const u = pass?.uniforms;
      if (u === undefined) throw new Error(`no beam${name} pass`);
      const vec = (key: string) => u[key] as readonly [number, number, number];
      const num = (key: string) => u[key] as number;
      const m = projectorMatrix({ eye: vec("lens"), lookAt: vec("lensAim"), roll: num("spin") }, {
        throwRatio: num("throwRatio"), aspect: num("aspect"), shiftX: num("shiftX"), shiftY: num("shiftY"), keystoneH: num("keystoneH"), keystoneV: num("keystoneV"),
      });
      // clip row r on the deck plane (x, deckTop, z): m[r]·x + m[8+r]·z + (m[4+r]·deckTop + m[12+r])
      const row = (r: number) => [m[r]!, m[8 + r]!, m[4 + r]! * FACTS.deckTop + m[12 + r]!] as const;
      const [cx, cy, cw] = [row(0), row(1), row(3)];
      return corners.map(([U, V]) => {
        const a = [cx[0] - U * cw[0], cx[1] - U * cw[1], -(cx[2] - U * cw[2])];
        const b = [cy[0] - V * cw[0], cy[1] - V * cw[1], -(cy[2] - V * cw[2])];
        const det = a[0]! * b[1]! - a[1]! * b[0]!;
        const x = (a[2]! * b[1]! - a[1]! * b[2]!) / det;
        const z = (a[0]! * b[2]! - a[2]! * b[0]!) / det;
        expect(cw[0] * x + cw[1] * z + cw[2]).toBeGreaterThan(0); // in front of the lens
        return [x, z] as const;
      });
    };
    const edge = (48 * 0.3048) / 2; // layout.py: twelve 4' decks across
    const lensZ = FACTS.projectors.SR.eye[2];
    const drop = FACTS.projectors.SR.eye[1] - FACTS.deckTop;
    const strip = 16 * 0.3048; // the two downstage deck rows
    const nearEdge = 6.3; // layout.py side_rig: where the near edge falls, from the centre line
    expect(drop / (values.sideThrow * 1.7778 * Math.sin((values.sideTilt * Math.PI) / 180))).toBeCloseTo(strip, 3);
    for (const name of ["SR", "SL"] as const) {
      const corners = onDeck(name, [[-1, -1], [1, -1], [1, 1], [-1, 1]]);
      const sign = name === "SR" ? -1 : 1; // its own side
      const near = corners.filter(([x]) => Math.sign(x) === sign);
      const far = corners.filter(([x]) => Math.sign(x) === -sign);
      expect(near).toHaveLength(2);
      // the far edge on the far deck edge: the beams cross; the near edge 1 m in from its own
      for (const [x] of far) expect(x).toBeCloseTo(-sign * edge, 2);
      for (const [x] of near) expect(x).toBeCloseTo(sign * nearEdge, 2);
      // square: both ends exactly the strip's 16', centred on the lens's depth
      for (const end of [near, far]) {
        expect(Math.abs(end[0]![1] - end[1]![1])).toBeCloseTo(strip, 2);
        expect((end[0]![1] + end[1]![1]) / 2).toBeCloseTo(lensZ, 2);
      }
      // and undistorted: the middle of the image lands midway between its ends
      expect(onDeck(name, [[0, 0]])[0]![0]).toBeCloseTo((sign * nearEdge - sign * edge) / 2, 2);
    }
  });

  it("the Side keystone faders drive both side projectors, H mirrored and V not", () => {
    const lensOf = (values: Record<string, number>) => {
      const { plan } = compiled(values);
      return (["SR", "SL"] as const).map((name) => {
        const pass = plan.passes.find((entry) => "nodeId" in entry && entry.nodeId === `beam${name}`) as { uniforms?: Record<string, number> } | undefined;
        return [pass?.uniforms?.["keystoneH"], pass?.uniforms?.["keystoneV"]];
      });
    };
    const [sr, sl] = lensOf({ sideKeyH: 12, sideKeyV: -4 });
    expect(sr![0]).toBeCloseTo(-12, 6);
    expect(sl![0]).toBeCloseTo(12, 6);
    expect(sr![1]).toBeCloseTo(-4, 6);
    expect(sl![1]).toBeCloseTo(-4, 6);
  });

  it("the deck floor has its own material on the Deck tone fader, drawn wherever the stage is", () => {
    const { graph, plan } = compiled({ deckTone: 0.6 });
    expect(graph.nodes["matDeck"]!.parameters["color"]).toMatchObject({ mode: "expression", bindings: { expression: { source: "op('slider_deckTone').chan.deckTone" } } });
    expect(graph.nodes["geoDeck"]!.parameters["material"]).toBe("material_deck");
    for (const render of ["stage", "shadowSR", "shadowSL", "shadowDS"]) expect(String(graph.nodes[render]!.parameters["scenes"]).split(" ")).toContain("geometry_deck");
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("upgrading with reset puts the named faders back to the export's values and keeps the rest", () => {
    const saved = stageDocument(FACTS);
    const nodes = { ...saved.graph.nodes };
    for (const [label, value] of [["sideTilt", 40], ["sideThrow", 3], ["dsTilt", 12]] as const) nodes[label] = { ...nodes[label]!, parameters: { ...nodes[label]!.parameters, value } };
    const upgraded = applyRig({ ...saved, graph: { ...saved.graph, nodes } }, FACTS, { reset: ["sideTilt", "sideThrow"] });
    expect(upgraded.graph.nodes["sideTilt"]!.parameters["value"]).toBeCloseTo(39.55, 2);
    expect(upgraded.graph.nodes["sideThrow"]!.parameters["value"]).toBe(1.2951);
    expect(upgraded.graph.nodes["dsTilt"]!.parameters["value"]).toBe(12);
  });

  it("upgrading finds the FX feed a session's owner rebuilt by hand, by its NAME: no second Syphon, no wire beside the owner's", () => {
    // The `-7` session: looked up by the id this project would have given it, the owner's
    // `syphonin_FX` was not found, so an upgrade added an empty second one and three more
    // wires, and the switch read six inputs where Source picks among three.
    const saved = savedByHand();
    const upgraded = applyRig(saved, FACTS).graph;
    const feeds = Object.values(upgraded.nodes).filter((entry) => entry.label === "syphonin_FX");
    expect(feeds.map((entry) => [entry.id, entry.parameters["source"]])).toEqual([["nd_fx", "Arena - FX"]]);
    // What Source picks among, in order: the owner's Transform still stands in slot 0.
    expect(into(upgraded, "feedFX", "inputs")).toEqual(["nd_trim", "testFX", "fxMap"]);
    expect(Object.keys(upgraded.nodes).sort()).toEqual(Object.keys(saved.graph.nodes).sort());
    expect(Object.keys(upgraded.edges).sort()).toEqual(Object.keys(saved.graph.edges).sort());
    // And it is still a session that renders: the feed reaches the pixel lines through the switch.
    const { plan } = compiled({ source: 1 }, { ...saved, graph: upgraded });
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(plan.passes.some((pass) => "nodeId" in pass && pass.nodeId === "nd_trim")).toBe(true);
  });

  it("upgrading twice is upgrading once, and upgrading an up-to-date session changes nothing in it", () => {
    const once = applyRig(savedByHand(), FACTS);
    expect(serializeProjectDocument(once)).not.toBe(serializeProjectDocument(savedByHand())); // it had something to bring up to date
    expect(serializeProjectDocument(applyRig(once, FACTS))).toBe(serializeProjectDocument(once));
    const fresh = stageDocument(FACTS);
    expect(serializeProjectDocument(applyRig(fresh, FACTS))).toBe(serializeProjectDocument(fresh));
  });

  it("upgrading keeps what the app measured on a mesh, and brings the sizes this project measures up to date", () => {
    // The app writes `clips`, `clipFrames` and `joints` on every Mesh File In it loads. An upgrade
    // that rebuilt the rig, deck and strobe meshes from nothing dropped them, so a session the app
    // had saved was never up to date for the tool, and one the tool had written never for the app.
    const remeasured: StageFacts = { ...FACTS, areas: { ...FACTS.areas, rig: { ...FACTS.areas.rig, vertices: 1052, triangles: 956 } } };
    const upgraded = applyRig(savedByHand(), remeasured).graph.nodes;
    for (const id of ["meshRig", "meshDeck", "meshStrobe", "meshStage"]) expect(upgraded[id]!.parameters, id).toMatchObject({ clipFrames: 0, clips: "", joints: "" });
    expect(upgraded["meshRig"]!.parameters).toMatchObject({ vertices: 1052, triangles: 956, select: "rig.*" });
  });

  it("the low fog sits on the deck the GLB measures: an upgrade brings the beams' floor up to the export, in all three passes", () => {
    // Read where it is consumed: each beam pass's own `floorY`. A saved session kept the deck
    // height of the export it was first built from, whatever the deck had since become.
    const floor = (document: ProjectDocument) => {
      const { plan } = compiled({}, document);
      return ["beamSR", "beamSL", "beamDS"].map((id) => (plan.passes.find((pass) => "nodeId" in pass && pass.nodeId === id) as { uniforms?: Record<string, number> } | undefined)?.uniforms?.["floorY"]);
    };
    const saved = savedByHand();
    expect(floor(saved)).toEqual([EARLIER_DECK_TOP, EARLIER_DECK_TOP, EARLIER_DECK_TOP]);
    expect(floor(applyRig(saved, FACTS))).toEqual([FACTS.deckTop, FACTS.deckTop, FACTS.deckTop]);
    // A beam whose shader its owner wrote has no floor of ours to move.
    const own = { ...saved, graph: { ...saved.graph, nodes: { ...saved.graph.nodes, beamDS: { ...saved.graph.nodes["beamDS"]!, parameters: { source: "// mine", floorY: 7 } } } } };
    expect(applyRig(own, FACTS).graph.nodes["beamDS"]!.parameters["floorY"]).toBe(7);
  });

  it("the session compiles with no warning: the drapes' depth-only render draws them unlit", () => {
    // That render names no light, being read for its depth alone, and a lit material in it said
    // "ambient floor only" twice in every session. The same holds for a session an upgrade wrote.
    const warnings = (document: ProjectDocument) => compiled({}, document).plan.diagnostics.filter((entry) => entry.severity !== "info").map((entry) => `${entry.code} ${entry.nodeId ?? ""}`);
    const { graph } = compiled();
    for (const id of ["geoCurtainDepth", "geoKabukiDepth"]) expect(graph.nodes[id]!.parameters["material"]).toBe("material_depth");
    expect(graph.nodes["matDepth"]!.type).toBe("materialUnlit");
    expect(warnings(stageDocument(FACTS))).toEqual([]);
    const saved = savedByHand();
    const lit = { ...saved, graph: { ...saved.graph, nodes: { ...saved.graph.nodes, geoCurtainDepth: { ...saved.graph.nodes["geoCurtainDepth"]!, parameters: { mode: "surface", material: "material_surface" } } } } };
    expect(warnings(lit)).toEqual(["node.scene.unlit drapeDepth"]);
    expect(warnings(applyRig(lit, FACTS))).toEqual([]);
  });
});
