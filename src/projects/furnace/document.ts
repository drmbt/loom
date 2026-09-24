import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import type { FurnaceSceneFacts } from "./scene-facts.ts";
import { markerAt } from "./scene-facts.ts";
import { RIG_ATTRIBUTES, rigKernel } from "./rig-kernel.ts";
import { SPARK_ATTRIBUTES, sparksKernel } from "./sparks-kernel.ts";
import { PLANT_SURFACE_WGSL } from "./surface-material.ts";
import { KEY_DIRECTION, SCATTER_LIGHTS, atmosphereWgsl } from "./atmosphere.ts";
import { BRIGHT_PASS_WGSL, GRADE_WGSL } from "./post.ts";
import { SHOP_ENVIRONMENT_WGSL } from "./environment.ts";
import { DOF_WGSL, GTAO_WGSL, SSR_WGSL } from "./screen-space.ts";

/**
 * T1354b — THE FURNACE DOCUMENT: the melt shop, lit, running, in smoke, graded.
 *
 * Built from the GLB's measured facts (`scene-facts.ts`) so a re-export is a rebuild, not a
 * hand edit. What is here is the LOOK and the MACHINE; the director that decides shots and
 * intensities from the music is §T1370b, so the lanes below are deliberately few and plain:
 * the low band breathes the furnace, the kick throws sparks from the tap, the hat flickers
 * the arc, the snare jolts the electrodes. Camera: one Blender shot, drifting.
 */

export interface FurnaceDocumentOptions {
  /** A `shot.*` camera from the GLB. */
  readonly shot: string;
  readonly width?: number;
  readonly height?: number;
  /** The track, as a path under public/. Absent: the owner's working track (Clankz 3), which build.ts copies there. */
  readonly audioUrl?: string;
}

/** Parameters may be slots (expressions, maps); the shared builder's signature takes values only. */
function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const HIT = (channel: string): string => `op('hits1').chan.${channel}`;
const LEVEL = (channel: string): string => `op('levels1').chan.${channel}`;

function vec(value: readonly [number, number, number]): number[] {
  return [value[0], value[1], value[2]];
}

export function furnaceDocument(facts: FurnaceSceneFacts, options: FurnaceDocumentOptions): ProjectDocument {
  const camera = facts.cameras.get(options.shot);
  if (camera === undefined) {
    throw new Error(`furnaceDocument: no camera "${options.shot}"; the GLB has ${[...facts.cameras.keys()].join(", ")}.`);
  }
  const eye = camera.eye;
  const aim: [number, number, number] = [eye[0] + camera.forward[0] * 12, eye[1] + camera.forward[1] * 12, eye[2] + camera.forward[2] * 12];
  const drift = (axis: 0 | 1 | 2, rate: number, depth: number): StoredParameter =>
    expressionSlot(`${eye[axis].toFixed(3)} + sin(abstime * ${rate}) * ${depth}`, eye[axis]);

  const lightNodes: GraphNode[] = [];
  const lightLabels: string[] = [];
  /** `shadowRange` casts a cube shadow over that many metres (T1362b); absent, the light does not cast. */
  const pointLight = (label: string, marker: string, color: readonly [number, number, number], intensity: StoredParameter, x: number, shadowRange?: number): void => {
    lightNodes.push(
      node(label, "light", [x, -900], {
        kind: "point",
        color: [color[0], color[1], color[2], 1],
        intensity,
        position: vec(markerAt(facts, marker)),
        ...(shadowRange === undefined ? {} : { shadows: true, shadowExtent: shadowRange, shadowSoftness: 1 }),
      }, { label: `${label}1` }),
    );
    lightLabels.push(`${label}1`);
  };
  // The furnace breathes with the low band; the arc flickers on the hats (and never quite
  // steadies — a real arc hunts); the high bays are dim sodium, the shop's only steady light.
  pointLight("furnace", "light.furnace_glow", [1, 0.5, 0.2], expressionSlot(`120 + ${LEVEL("low")} * 120`, 160), -2400, 35);
  pointLight("arc", "light.arc", [0.6, 0.7, 1], expressionSlot(`40 + ${HIT("hatCount")} * 420 + sin(abstime * 37) * 18`, 60), -2200);
  pointLight("slag", "light.slag_door", [1, 0.42, 0.12], 110, -2000, 25);
  pointLight("tap", "light.tap", [1, 0.55, 0.2], expressionSlot(`30 + ${HIT("kickCount")} * 120`, 45), -1800, 20);
  pointLight("tundish", "light.tundish", [1, 0.5, 0.18], 45, -1600);
  for (let bay = 1; bay <= 4; bay += 1) pointLight(`bay${bay}`, `light.high_bay_${bay}`, [1, 0.74, 0.46], 380, -1400 + bay * 200);

  const atmosphereScatter: Record<string, StoredParameter> = {};
  for (const light of SCATTER_LIGHTS) atmosphereScatter[light.param] = light.rest;
  atmosphereScatter["furnaceGlow"] = expressionSlot(`14 + ${LEVEL("low")} * 16`, 20);
  atmosphereScatter["slagGlow"] = 10;
  atmosphereScatter["tundishGlow"] = 8;
  atmosphereScatter["lamps"] = 2.5;
  atmosphereScatter["density"] = 0.009;
  atmosphereScatter["ambientSmoke"] = [0.002, 0.0025, 0.0035];
  atmosphereScatter["arcFlash"] = expressionSlot(`6 + ${HIT("hatCount")} * 60`, 10);
  atmosphereScatter["tapGlow"] = expressionSlot(`10 + ${HIT("kickCount")} * 30`, 15);

  const cameraRef = (field: string, fallback: number): StoredParameter => expressionSlot(`op('cam1').par.${field}`, fallback);

  const nodes: GraphNode[] = [
    // ── Audio (a stand-in track until the song arrives) ──
    node("clip", "audioFileIn", [-4200, 1400], { file: options.audioUrl ?? "media/furnace/clankz3.wav", playMode: "timeline" }, { label: "clip1" }),
    node("pickLevels", "valueSelect", [-3900, 1300], { channels: "level low high" }, { label: "picklevels1" }),
    node("smooth", "valueLag", [-3600, 1300], { lag: 0.08, releaseRatio: 1 }, { label: "smooth1" }),
    node("rank", "valueNormalize", [-3300, 1300], { window: 16 }, { label: "rank1" }),
    node("levels", "valueLag", [-3000, 1300], { lag: 0.15, releaseRatio: 1 }, { label: "levels1" }),
    node("pickHits", "valueSelect", [-3900, 1550], { channels: "kickCount snareCount hatCount" }, { label: "pickhits1" }),
    node("hits", "valueLag", [-3600, 1550], { lag: 0.001, releaseRatio: 250 }, { label: "hits1" }),
    // ── The shop ──
    node("plant", "meshFileIn", [-3600, -300], { file: facts.glbUrl, select: facts.plant.select, vertices: facts.plant.vertices, triangles: facts.plant.triangles, parts: facts.plant.parts }, { label: "plant1" }),
    node("machines", "meshFileIn", [-3600, 0], { file: facts.glbUrl, select: facts.machines.select, vertices: facts.machines.vertices, triangles: facts.machines.triangles, parts: facts.machines.parts }, { label: "machines1" }),
    node("rig", "pointKernel", [-3300, 0], {
      capacity: facts.machines.vertices,
      attributes: RIG_ATTRIBUTES,
      kernel: rigKernel(facts),
      // The shop at work, slowly: the scrap crane crosses the bay, the ladle crane waits,
      // the electrodes hunt with the snare, the belt and the strand run.
      craneX: expressionSlot("sin(abstime * 0.045) * 9", 0),
      trolley: expressionSlot("sin(abstime * 0.07 + 1.3) * 2.5", 0),
      hook: expressionSlot("-2.5 + sin(abstime * 0.11) * 1.8", -2.5),
      bucketSway: expressionSlot("sin(abstime * 0.9) * 0.03", 0),
      crane2X: expressionSlot("sin(abstime * 0.03 + 2.0) * 6", 0),
      hook2: expressionSlot("-1 + sin(abstime * 0.09) * 1.2", -1),
      electrode1: expressionSlot(`-0.35 + ${HIT("snareCount")} * 0.18 + sin(abstime * 3.1) * 0.03`, -0.35),
      electrode2: expressionSlot(`-0.3 + ${HIT("snareCount")} * 0.14 + sin(abstime * 2.7 + 1.0) * 0.03`, -0.3),
      electrode3: expressionSlot(`-0.4 + ${HIT("snareCount")} * 0.16 + sin(abstime * 3.4 + 2.0) * 0.03`, -0.4),
      ladleTilt: expressionSlot("max(sin(abstime * 0.05), 0.0) * 0.35", 0),
      casting: expressionSlot("abstime * 0.4", 0),
      conveyor: expressionSlot("abstime * 1.2", 0),
    }, { label: "rig1" }),
    node("steel", "materialWgsl", [-3000, -600], { model: "pbr", source: PLANT_SURFACE_WGSL, heatPulse: expressionSlot(`${LEVEL("low")} * 0.35`, 0.1) }, { label: "steel1" }),
    node("plantGeo", "geometry", [-3000, -300], { mode: "surface", material: "steel1" }, { label: "plantgeo1" }),
    node("machineGeo", "geometry", [-3000, 0], { mode: "surface", material: "steel1" }, { label: "machinegeo1" }),
    // ── Sparks ──
    node("sparks", "pointKernel", [-3300, 400], {
      capacity: 8000,
      attributes: SPARK_ATTRIBUTES,
      kernel: sparksKernel(facts),
      tapRate: expressionSlot(`0.08 + ${HIT("kickCount")} * 0.8`, 0.15),
      slagRate: 0.12,
      arcRate: expressionSlot(`0.05 + ${HIT("hatCount")} * 0.5`, 0.12),
      torchRate: 0.35,
      pourRate: expressionSlot("max(sin(abstime * 0.05), 0.0) * 0.6", 0),
      brightness: 9,
    }, { label: "sparks1" }),
    node("sparkMat", "materialUnlit", [-3000, 700], { color: [1, 1, 1, 1] }, { label: "sparkmat1" }),
    node("sparkGeo", "geometry", [-3000, 400], {
      mode: "beam",
      material: "sparkmat1",
      endpoint: "endpoint",
      blend: "additive",
      scale: 0.012,
      taper: 0.3,
      tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
    }, { label: "sparkgeo1" }),
    // ── Camera and light ──
    node("cam", "camera", [-2700, -900], {
      eye: vec(eye),
      lookAt: aim,
      fov: camera.fovDeg,
      near: 0.1,
      far: 400,
      "eye.x": drift(0, 0.07, 0.35),
      "eye.y": drift(1, 0.05, 0.15),
      "eye.z": drift(2, 0.06, 0.3),
    }, { label: "cam1" }),
    node("key", "light", [-2600, -900], {
      kind: "directional",
      direction: [KEY_DIRECTION[0], KEY_DIRECTION[1], KEY_DIRECTION[2]],
      color: [0.82, 0.88, 1, 1],
      intensity: 3.2,
      shadows: true,
      shadowExtent: 80,
      shadowSoftness: 1,
    }, { label: "key1" }),
    ...lightNodes,
    node("envSeed", "ramp", [-2700, 300], {}, { label: "envseed1", resolution: { mode: "fixed", width: 1024, height: 512 } }),
    node("env", "customWgsl", [-2700, 500], { source: SHOP_ENVIRONMENT_WGSL }, { label: "env1" }),
    node("shot", "render", [-2400, 0], {
      scenes: "plantgeo1 machinegeo1 sparkgeo1",
      camera: "cam1",
      lights: ["key1", ...lightLabels].join(" "),
      ambientColor: [0.56, 0.58, 0.6, 1],
      ambientIntensity: 0.012,
      background: [0, 0, 0, 1],
      antialias: "msaa",
      depthOutput: true,
      normalOutput: true,
      environmentIntensity: 0.6,
      environmentTaps: 12,
      ambientOcclusion: true,
      aoRadius: 0.8,
    }, { label: "shot1" }),
    // ── Air, bloom, grade ──
    // Screen space on the G-buffer (T1371b): contact occlusion, then reflections, then air.
    node("occlusion", "customWgslMulti", [-2100, 0], {
      source: GTAO_WGSL,
      eye: vec(eye),
      aim,
      "eye.x": cameraRef("eye.x", eye[0]),
      "eye.y": cameraRef("eye.y", eye[1]),
      "eye.z": cameraRef("eye.z", eye[2]),
      "aim.x": cameraRef("lookAt.x", aim[0]),
      "aim.y": cameraRef("lookAt.y", aim[1]),
      "aim.z": cameraRef("lookAt.z", aim[2]),
      fov: cameraRef("fov", camera.fovDeg),
      far: cameraRef("far", 400),
    }, { label: "occlusion1", resolution: { mode: "project" } }),
    node("reflections", "customWgslMulti", [-1800, 0], {
      source: SSR_WGSL,
      eye: vec(eye),
      aim,
      "eye.x": cameraRef("eye.x", eye[0]),
      "eye.y": cameraRef("eye.y", eye[1]),
      "eye.z": cameraRef("eye.z", eye[2]),
      "aim.x": cameraRef("lookAt.x", aim[0]),
      "aim.y": cameraRef("lookAt.y", aim[1]),
      "aim.z": cameraRef("lookAt.z", aim[2]),
      fov: cameraRef("fov", camera.fovDeg),
      far: cameraRef("far", 400),
    }, { label: "reflections1", resolution: { mode: "project" } }),
    node("air", "customWgslMulti", [-1500, 0], {
      source: atmosphereWgsl(facts),
      ...atmosphereScatter,
      eye: vec(eye),
      aim,
      "eye.x": cameraRef("eye.x", eye[0]),
      "eye.y": cameraRef("eye.y", eye[1]),
      "eye.z": cameraRef("eye.z", eye[2]),
      "aim.x": cameraRef("lookAt.x", aim[0]),
      "aim.y": cameraRef("lookAt.y", aim[1]),
      "aim.z": cameraRef("lookAt.z", aim[2]),
      fov: cameraRef("fov", camera.fovDeg),
      far: cameraRef("far", 400),
    }, { label: "air1", resolution: { mode: "project" } }),
    node("lens", "customWgslMulti", [-1350, 0], {
      source: DOF_WGSL,
      aperture: 0.22,
      eye: vec(eye),
      aim,
      "eye.x": cameraRef("eye.x", eye[0]),
      "eye.y": cameraRef("eye.y", eye[1]),
      "eye.z": cameraRef("eye.z", eye[2]),
      "aim.x": cameraRef("lookAt.x", aim[0]),
      "aim.y": cameraRef("lookAt.y", aim[1]),
      "aim.z": cameraRef("lookAt.z", aim[2]),
      fov: cameraRef("fov", camera.fovDeg),
      far: cameraRef("far", 400),
    }, { label: "lens1", resolution: { mode: "project" } }),
    node("bright", "customWgsl", [-1200, 300], { source: BRIGHT_PASS_WGSL, threshold: 2.2, knee: 1 }, { label: "bright1", resolution: { mode: "scale", factor: 0.5 } }),
    node("bloomNear", "blur", [-900, 250], { size: 10, filter: "gaussian", extend: "hold" }, { label: "bloomnear1", resolution: { mode: "scale", factor: 0.5 } }),
    node("bloomFar", "blur", [-900, 450], { size: 14, filter: "gaussian", extend: "hold" }, { label: "bloomfar1", resolution: { mode: "scale", factor: 0.25 } }),
    node("bloomSum", "add", [-600, 350], { opacity: 1 }, { label: "bloomsum1", resolution: { mode: "scale", factor: 0.5 } }),
    node("glow", "add", [-300, 0], { opacity: 0.14 }, { label: "glow1", resolution: { mode: "project" } }),
    // Auto-exposure (T1378b): meter the frame's log-average luminance, adapt toward a key
    // like an eye does — faster when the scene brightens than when it darkens — and hand the
    // grade the gain. One frame late by the meter's contract; the lag hides it.
    node("meter", "analyze", [-300, 300], { channel: "luminance", operation: "logAverage" }, { label: "meter1" }),
    node("metered", "channelIn", [0, 300], { channel: "meter1", fallback: 0.05 }, { label: "metered1" }),
    node("adaptation", "valueLag", [300, 300], { lag: 0.35, releaseRatio: 3 }, { label: "adaptation1" }),
    node("grade", "customWgsl", [0, 0], { source: GRADE_WGSL, exposure: 0.2, adapt: expressionSlot("clamp(0.075 / max(op('adaptation1').chan.value, 0.0005), 0.35, 10)", 1), punch: 1.3, punchSaturation: 1.05, contrast: 1.1, grain: 0.016, saturation: 0.9, split: 0.12, shadowTint: [0.94, 1, 1, 1], highlightTint: [1.03, 1, 0.96, 1] }, { label: "grade1", resolution: { mode: "project" } }),
    node("out", "output", [300, 0], { toneMap: "none" }, { label: "out1" }),
  ];

  const edges: GraphEdge[] = [
    edge("clip-levels", ["clip", "out"], ["pickLevels", "in"]),
    edge("levels-smooth", ["pickLevels", "out"], ["smooth", "in"]),
    edge("smooth-rank", ["smooth", "out"], ["rank", "in"]),
    edge("rank-levels", ["rank", "out"], ["levels", "in"]),
    edge("clip-hits", ["clip", "out"], ["pickHits", "in"]),
    edge("hits-lag", ["pickHits", "out"], ["hits", "in"]),
    edge("seed-env", ["envSeed", "out"], ["env", "input"]),
    edge("env-shot", ["env", "out"], ["shot", "environment"]),
    edge("plant-geo", ["plant", "out"], ["plantGeo", "points"]),
    edge("machines-rig", ["machines", "out"], ["rig", "in"]),
    edge("rig-geo", ["rig", "out"], ["machineGeo", "points"]),
    edge("sparks-geo", ["sparks", "out"], ["sparkGeo", "points"]),
    edge("shot-occlusion", ["shot", "out"], ["occlusion", "input"]),
    edge("depth-occlusion", ["shot", "depth"], ["occlusion", "more"], 0),
    edge("normal-occlusion", ["shot", "normal"], ["occlusion", "more"], 1),
    edge("occlusion-reflections", ["occlusion", "out"], ["reflections", "input"]),
    edge("depth-reflections", ["shot", "depth"], ["reflections", "more"], 0),
    edge("normal-reflections", ["shot", "normal"], ["reflections", "more"], 1),
    edge("reflections-air", ["reflections", "out"], ["air", "input"]),
    edge("depth-air", ["shot", "depth"], ["air", "more"], 0),
    edge("air-lens", ["air", "out"], ["lens", "input"]),
    edge("depth-lens", ["shot", "depth"], ["lens", "more"], 0),
    edge("lens-bright", ["lens", "out"], ["bright", "input"]),
    edge("bright-near", ["bright", "out"], ["bloomNear", "input"]),
    edge("bright-far", ["bright", "out"], ["bloomFar", "input"]),
    edge("near-sum", ["bloomNear", "out"], ["bloomSum", "in1"]),
    edge("far-sum", ["bloomFar", "out"], ["bloomSum", "in2"]),
    edge("lens-glow", ["lens", "out"], ["glow", "in1"]),
    edge("sum-glow", ["bloomSum", "out"], ["glow", "in2"]),
    edge("glow-grade", ["glow", "out"], ["grade", "input"]),
    edge("glow-meter", ["glow", "out"], ["meter", "input"]),
    edge("metered-adaptation", ["metered", "out"], ["adaptation", "in"]),
    edge("grade-out", ["grade", "out"], ["out", "input"]),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-furnace",
    name: "Furnace",
    graph: graph(nodes, edges),
    settings: settings({ outputResolution: { width: options.width ?? 1920, height: options.height ?? 1080 }, randomSeed: 11 }),
    assets: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}
