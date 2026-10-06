import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { ParameterSlot, ParameterValue } from "../../domain/types/parameters.ts";
import { chan, follow, grey, shadowFovSource, viewSlots, type Slots } from "./slots.ts";
import { applyRig } from "./rig.ts";
import { LIMITS, document, edge, expressionSlot, graph, node, settings } from "../../examples/documents/builders.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import { PROJECTORS, type Area, type ProjectorName, type StageFacts } from "./facts.ts";
import { beamShader, compositeShader } from "./haze.ts";
import { TEST_BEAMS_WGSL, TEST_GRID_WGSL } from "./test-content.ts";

/**
 * Stage previz — the Loom session (built by build.ts from the Blender GLB).
 *
 *   syphonSR ─┐                                 ┌► projSR ┐
 *   testBeams ┼► feedSR(switch) ───────────────┤         │
 *   testGrid ─┘                                 │         ├─(names)─► stage(render) ─┬─► beamSR ─► beamSL ─► beamDS ─┐
 *   syphonSL ─┬► feedSL(switch) ─► flipSL(flip) ┴► projSL ┤                          └──────────── depth ────────────┼► atmosphere ─► out
 *   syphonDS ─┬► feedDS(switch) ──────────────────► projDS ┘                                                           │
 *   testVideo ┘                                                                                                        │
 *   meshStage/Grid/Curtain/Kabuki/Led/Talent ─► (kabukiFly, talentShow kernels) ─► geo* ─(names)─► stage             │
 *   shadowCam{SR,SL,DS} (on each projector's pose) ─► shadow{SR,SL,DS}(render, depth) ─► beam{SR,SL,DS}               │
 *
 * One `source` switch for all three feeds: 0 LIVE (Syphon from Resolume), 1 TEST (animated
 * beam looks on the sides, a video on the DS), 2 GRID (the alignment chart everywhere).
 * Stage left is flipped horizontally AFTER the switch, so live and test content are
 * mirrored alike and the two side throws read symmetric from the house.
 *
 * Stage left is +x (the audience's right); stage right is −x.
 */

/** Haze knobs, shared by the beam passes and the composite so the two can never disagree. */
const DENSITY = `${chan("haze")} * 0.06`;
const FOG = `${chan("fog")} * 0.3`;
const GAIN = `${chan("beams")} * 40`;

const COL = { tests: -4400, syphon: -4100, switches: -3800, flip: -3500, rig: -3200, mesh: -4400, kernels: -4100, geo: -3800, scene: -3500, render: -2900, beams: -2600, mix: -2300, out: -2000 } as const;

const PROJECTOR_Y: Record<ProjectorName, number> = { SR: 0, SL: 300, DS: 600 };
/** The base areas; `rig` (the moving projector bodies) and `deck` (the floor, its own material) are added by rig.ts with their controls. */
const MESH_Y: Record<Exclude<Area, "rig" | "deck" | "strobe">, number> = { stage: 1300, grid: 1520, curtain: 1740, kabuki: 1960, led: 2180, talent: 2400 };

export function stageDocument(facts: StageFacts): ProjectDocument {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (entry: GraphNode): void => {
    nodes.push(entry);
  };
  const wire = (id: string, from: readonly [string, string], to: readonly [string, string], order?: number): void => {
    edges.push(edge(id, from, to, order));
  };
  const labelled = (id: string, type: string, position: readonly [number, number], parameters: Record<string, ParameterValue>, extra: Partial<GraphNode> = {}): GraphNode =>
    node(id, type, position, parameters, { label: id, ...extra });

  // ---- the desk ---------------------------------------------------------------------------
  const controls: Array<[string, string, number, number, number, number]> = [
    // label, caption, value, min, max, step
    ["source", "Source: live · test · grid", 1, 0, 2, 1],
    ["shot", "Shot: FOH · iso · wing · proj · wide", 0, 0, 4, 1],
    ["kabuki", "Kabuki: in → out", 1, 0, 1, 0],
    ["haze", "Haze", 0.5, 0, 1, 0],
    ["fog", "Low fog", 0.35, 0, 1, 0],
    ["beams", "Beam visibility", 0.5, 0, 1, 0],
    ["leds", "LEDs", 0.6, 0, 1, 0],
    ["work", "Work light", 0.15, 0, 1, 0],
  ];
  controls.forEach(([label, caption, value, min, max, step], index) => {
    add(labelled(label, "slider", [COL.tests + (index % 3) * 300, -900 + Math.floor(index / 3) * 170], { channel: label, caption, value, defaultValue: value, min, max, step }));
    wire(`e-${label}-desk`, [label, "out"], ["desk", "controls"], index);
  });
  add(labelled("talent", "toggle", [COL.tests + 600, -900 + 3 * 170], { channel: "talent", caption: "Talent stand-ins", on: true, defaultOn: true }));
  wire("e-talent-desk", ["talent", "out"], ["desk", "controls"], controls.length);
  add(labelled("desk", "panel", [COL.tests + 960, -900], {
    title: "Stage previz",
    remote: false,
    board: serializePanelBoard({
      columns: 6,
      items: [
        { label: "Feeds and view", rect: { x: 0, y: 0, w: 6, h: 1 } },
        { member: "source", rect: { x: 0, y: 1, w: 3, h: 1 } },
        { member: "shot", rect: { x: 3, y: 1, w: 3, h: 1 } },
        { label: "Stage", rect: { x: 0, y: 2, w: 6, h: 1 } },
        { member: "kabuki", rect: { x: 0, y: 3, w: 2, h: 1 } },
        { member: "leds", rect: { x: 2, y: 3, w: 2, h: 1 } },
        { member: "work", rect: { x: 4, y: 3, w: 2, h: 1 } },
        { label: "Atmosphere", rect: { x: 0, y: 4, w: 6, h: 1 } },
        { member: "haze", rect: { x: 0, y: 5, w: 2, h: 1 } },
        { member: "fog", rect: { x: 2, y: 5, w: 2, h: 1 } },
        { member: "beams", rect: { x: 4, y: 5, w: 2, h: 1 } },
        { member: "talent", rect: { x: 0, y: 6, w: 2, h: 1 } },
      ],
    }),
  }));
  add(labelled("noteFeeds", "annotate", [COL.tests + 1560, -900], {
    title: "Feeds",
    body: [
      // (A note is prose, which the rename in names.ts does not rewrite: it names nodes as the session saves them.)
      "Resolume → Syphon: select each server in syphonin_SR / syphonin_SL / syphonin_DS (inspector, Source). Desktop app on macOS only.",
      "Source switch: 0 live Syphon, 1 test content, 2 alignment grid. Stage left (projector_SL) is flipped horizontally after the switch.",
      "Sending one feed to both sides? Pick the same Syphon server in syphonin_SR and syphonin_SL: the flip makes them mirror.",
    ].join("\n"),
    color: "input",
  }, { size: { width: 560, height: 150 } }));

  // ---- feeds ------------------------------------------------------------------------------
  add(labelled("blank", "solid", [COL.tests, 940], { color: [0, 0, 0, 1] }, { resolution: { mode: "fixed", width: 1920, height: 1080 } }));
  add(labelled("testBeams", "customWgsl", [COL.tests, 0], { source: TEST_BEAMS_WGSL, look: -1, hold: 8, hue: 0, level: 1 }));
  add(labelled("testGrid", "customWgsl", [COL.tests, 320], { source: TEST_GRID_WGSL, cells: 16, level: 1 }));
  add(labelled("testVideo", "movieFileIn", [COL.tests, 640], { file: "media/shibuya-crossing.mp4", playMode: "freeRun", play: true, speed: 1, extend: "loop" }, { resolution: { mode: "fixed", width: 1280, height: 720 } }));
  wire("e-blank-testBeams", ["blank", "out"], ["testBeams", "input"]);
  wire("e-blank-testGrid", ["blank", "out"], ["testGrid", "input"]);
  for (const name of PROJECTORS) {
    const y = PROJECTOR_Y[name];
    const syphon = `syphon${name}`;
    const feed = `feed${name}`;
    add(labelled(syphon, "syphonIn", [COL.syphon, y], { source: "" }));
    add(labelled(feed, "switch", [COL.switches, y], {}, { parameters: { index: expressionSlot(chan("source"), 1) } }));
    wire(`e-${syphon}-${feed}`, [syphon, "out"], [feed, "inputs"], 0);
    wire(`e-test-${feed}`, [name === "DS" ? "testVideo" : "testBeams", "out"], [feed, "inputs"], 1);
    wire(`e-grid-${feed}`, ["testGrid", "out"], [feed, "inputs"], 2);
  }
  add(labelled("flipSL", "flip", [COL.flip, PROJECTOR_Y.SL], { flipx: true, flipy: false }));
  wire("e-feedSL-flipSL", ["feedSL", "out"], ["flipSL", "input"]);

  // ---- projectors -------------------------------------------------------------------------
  for (const name of PROJECTORS) {
    const rig = facts.projectors[name];
    add(labelled(`proj${name}`, "projector", [COL.rig, PROJECTOR_Y[name]], {
      eye: [...rig.eye], lookAt: [...rig.lookAt], roll: 0,
      throwRatio: Math.round(rig.throwRatio * 1000) / 1000, aspect: Math.round(rig.aspect * 10000) / 10000,
      shiftX: 0, shiftY: 0, keystoneH: 0, keystoneV: 0,
      brightness: name === "DS" ? 1.1 : 1.6, color: [1, 1, 1, 1], falloff: true, occlusion: true,
    }));
    wire(`e-cookie-${name}`, [name === "SL" ? "flipSL" : `feed${name}`, "out"], [`proj${name}`, "cookie"]);
  }

  // ---- the stage --------------------------------------------------------------------------
  const kabuki = facts.areas.kabuki;
  for (const area of Object.keys(MESH_Y) as Array<keyof typeof MESH_Y>) {
    const mesh = facts.areas[area];
    const meshId = `mesh${area[0]!.toUpperCase()}${area.slice(1)}`;
    const geoId = `geo${area[0]!.toUpperCase()}${area.slice(1)}`;
    add(labelled(meshId, "meshFileIn", [COL.mesh, MESH_Y[area]], { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles }));
    add(labelled(geoId, "geometry", [COL.geo, MESH_Y[area]], { mode: "surface", material: area === "led" ? "matLed" : "matSurface" }));
    if (area === "kabuki" || area === "talent") {
      const kernelId = area === "kabuki" ? "kabukiFly" : "talentShow";
      add(labelled(kernelId, "pointKernel", [COL.kernels, MESH_Y[area]], {
        capacity: mesh.vertices,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: area === "kabuki" ? kabukiKernel(kabuki.topY) : TALENT_KERNEL,
      }, { parameters: area === "kabuki" ? { lift: expressionSlot(chan("kabuki"), 1) } : { show: expressionSlot(chan("talent"), 1) } }));
      wire(`e-${meshId}-${kernelId}`, [meshId, "out"], [kernelId, "in"]);
      wire(`e-${kernelId}-${geoId}`, [kernelId, "out"], [geoId, "points"]);
    } else {
      wire(`e-${meshId}-${geoId}`, [meshId, "out"], [geoId, "points"]);
    }
  }
  /* White base: the GLB's own factors (colour, roughness, metallic) ride the mesh and win. */
  add(labelled("matSurface", "materialPbr", [COL.kernels, 2620], { color: [1, 1, 1, 1], metallic: 0, roughness: 0.5 }));
  /* Unlit: LED faces are light, not lit — and an unlit surface takes no projector light and casts no projector shadow. */
  add(labelled("matLed", "materialUnlit", [COL.kernels, 2780], {}, { parameters: { color: expressionSlot(`${chan("leds")} * 3`, grey(1.8)) } }));

  add(labelled("workKey", "light", [COL.scene, 1300], {
    kind: "directional", direction: [0.35, -0.75, -0.55], color: [1, 0.94, 0.86, 1], shadows: false,
  }, { parameters: { intensity: expressionSlot(`${chan("work")} * 0.9`, 0.14) } }));
  add(labelled("workRim", "light", [COL.scene, 1520], {
    kind: "directional", direction: [-0.3, -0.55, 0.78], color: [0.7, 0.8, 1, 1], shadows: false,
  }, { parameters: { intensity: expressionSlot(`${chan("work")} * 0.5`, 0.08) } }));

  const first = facts.shots[0]!;
  add(labelled("view", "camera", [COL.scene, 1740], { near: 0.1, far: 120, ortho: false, roll: 0 }, { parameters: viewSlots(facts) }));

  const surfaces = "geoStage geoGrid geoCurtain geoKabuki geoTalent";
  add(labelled("stage", "render", [COL.render, 900], {
    scenes: `${surfaces} geoLed`, camera: "view", lights: "workKey workRim", projectors: "projSR projSL projDS",
    ambientColor: [0.6, 0.66, 0.8, 1], ambientIntensity: 0.04, background: [0, 0, 0, 1],
    depthOutput: true, antialias: "msaa",
  }));

  // ---- each projector's own view of what blocks it (for shadows in the air) -------------
  for (const name of PROJECTORS) {
    const rig = facts.projectors[name];
    const proj = `proj${name}`;
    const camId = `shadowCam${name}`;
    const renderId = `shadow${name}`;
    const y = 3000 + PROJECTOR_Y[name] * 0.8;
    const fov = shadowFovSource(proj);
    add(labelled(camId, "camera", [COL.scene, y], { near: 0.1, far: 60, ortho: false }, {
      parameters: {
        ...follow("eye", proj, "eye", rig.eye),
        ...follow("lookAt", proj, "lookAt", rig.lookAt),
        roll: expressionSlot(`op('${proj}').par.roll`, 0),
        fov: expressionSlot(fov, 40),
      },
    }));
    add(labelled(renderId, "render", [COL.render, y], {
      scenes: surfaces, camera: camId, lights: "workKey", ambientIntensity: 0, depthOutput: true,
    }, { resolution: { mode: "fixed", width: 512, height: 288 } }));
  }

  // ---- haze: one beam pass per projector, then the composite ----------------------------
  const view: Slots = {
    ...follow("eye", "view", "eye", first.eye),
    ...follow("aim", "view", "lookAt", first.lookAt),
    fov: expressionSlot("op('view').par.fov", first.fov),
    far: expressionSlot("op('view').par.far", 120),
    roll: expressionSlot("op('view').par.roll", 0),
  };
  let previous: string | null = null;
  for (const name of PROJECTORS) {
    const rig = facts.projectors[name];
    const proj = `proj${name}`;
    const beamId = `beam${name}`;
    const parameter = (key: string): ParameterSlot => expressionSlot(`op('${proj}').par.${key}`, 0);
    add(labelled(beamId, "customWgslMulti", [COL.beams, 600 + PROJECTOR_Y[name] * 0.8], {
      source: beamShader(name, previous !== null),
      floorY: facts.deckTop, fogHeight: 0.8, drift: 0.6, anisotropy: 0.55, reach: 80,
    }, {
      resolution: { mode: "fixed", width: 960, height: 540 },
      parameters: {
        ...view,
        ...follow("lens", proj, "eye", rig.eye),
        ...follow("lensAim", proj, "lookAt", rig.lookAt),
        spin: parameter("roll"),
        throwRatio: expressionSlot(`op('${proj}').par.throwRatio`, rig.throwRatio),
        aspect: expressionSlot(`op('${proj}').par.aspect`, rig.aspect),
        shiftX: parameter("shiftX"),
        shiftY: parameter("shiftY"),
        keystoneH: parameter("keystoneH"),
        keystoneV: parameter("keystoneV"),
        brightness: expressionSlot(`op('${proj}').par.brightness`, 1),
        shadowFov: expressionSlot(`op('shadowCam${name}').par.fov`, 40),
        shadowFar: expressionSlot(`op('shadowCam${name}').par.far`, 60),
        density: expressionSlot(DENSITY, 0.03),
        fog: expressionSlot(FOG, 0.1),
        gain: expressionSlot(GAIN, 20),
      },
    }));
    wire(`e-cookie-${beamId}`, [name === "SL" ? "flipSL" : `feed${name}`, "out"], [beamId, "input"]);
    wire(`e-depth-${beamId}`, ["stage", "depth"], [beamId, "more"], 0);
    wire(`e-shadow-${beamId}`, [`shadow${name}`, "depth"], [beamId, "more"], 1);
    if (previous !== null) wire(`e-${previous}-${beamId}`, [previous, "out"], [beamId, "more"], 2);
    previous = beamId;
  }
  add(labelled("atmosphere", "customWgslMulti", [COL.mix, 900], {
    source: compositeShader(), ambient: [0.004, 0.0045, 0.006], reach: 80, knee: 0.75,
  }, { parameters: { ...view, density: expressionSlot(DENSITY, 0.03) } }));
  wire("e-stage-atmosphere", ["stage", "out"], ["atmosphere", "input"]);
  wire("e-depth-atmosphere", ["stage", "depth"], ["atmosphere", "more"], 0);
  wire("e-beams-atmosphere", [previous ?? "beamDS", "out"], ["atmosphere", "more"], 1);
  add(labelled("out", "output", [COL.out, 900], {}));
  wire("e-atmosphere-out", ["atmosphere", "out"], ["out", "input"]);

  return applyRig(document(
    "stage-previz",
    "Stage previz",
    settings({ outputResolution: { width: 1920, height: 1080 }, randomSeed: 11, limits: { ...LIMITS, memoryBudgetBytes: 2_147_483_648 } }),
    graph(nodes, edges),
  ), facts);

}

/** The kabuki flies out: every vertex rises to the pipe line, and once out it is parked high above the rig. */
function kabukiKernel(top: number): string {
  return `// Stage previz — kabuki fly-out (generated by src/projects/stage-previz/document.ts).
struct Params {
  lift: f32, // @default 0  0 = the kabuki hangs in; 1 = flown out to its pipe and parked out of sight.
};

const TOP: f32 = ${top.toFixed(4)};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let k = smoothstep(0.0, 1.0, clamp(ctx.params.lift, 0.0, 1.0));
  q.position.y = mix(p.position.y, TOP, k) + select(0.0, 80.0, k > 0.999);
  return q;
}`;
}

const TALENT_KERNEL = `// Stage previz — talent stand-ins on or off (generated by src/projects/stage-previz/document.ts).
struct Params {
  show: f32, // @default 1  1 shows the two dancers and the vocalist; 0 parks them under the floor.
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.y = p.position.y - select(200.0, 0.0, ctx.params.show > 0.5);
  return q;
}`;
