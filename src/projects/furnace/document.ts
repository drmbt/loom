import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import type { FurnaceSceneFacts } from "./scene-facts.ts";
import { markerAt } from "./scene-facts.ts";
import { RIG_ATTRIBUTES, rigKernel } from "./rig-kernel.ts";
import { SPARK_ATTRIBUTES, sparksKernel } from "./sparks-kernel.ts";
import { PLANT_SURFACE_WGSL, SKY_SURFACE_WGSL } from "./surface-material.ts";
import { KEY_DIRECTION, SCATTER_LIGHTS, atmosphereWgsl } from "./atmosphere.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL, GRADE_WGSL } from "./post.ts";
import { SHOP_ENVIRONMENT_WGSL } from "./environment.ts";
import { DOF_WGSL, GTAO_WGSL, MOTION_BLUR_WGSL, SSR_WGSL } from "./screen-space.ts";
import { shotPath } from "./camera-path.ts";
import { GLITCH_WGSL } from "./glitch.ts";
import { director } from "./director.ts";
import { fixturesOf } from "./fixtures.ts";
import { lampsWgsl } from "./lamps.ts";
import { sunView } from "./sun.ts";

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
  /** A `shot.*` camera from the GLB, held with a drift; absent, the camera runs the cut (camera-path.ts). */
  readonly shot?: string;
  readonly width?: number;
  readonly height?: number;
  /** Hold one CUT entry and play its move from t = 0 (the director still drives everything else): previewing a framing. */
  readonly cutIndex?: number;
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
  const shotName = options.shot ?? "shot.hero_low_furnace";
  const camera = facts.cameras.get(shotName);
  if (camera === undefined) {
    throw new Error(`furnaceDocument: no camera "${shotName}"; the GLB has ${[...facts.cameras.keys()].join(", ")}.`);
  }
  // The director (T1370b) decides the cut from the music; moves run on time since the cut,
  // faster through a build-up. The previous camera is the director one frame back.
  const direction = director("clip", [-4200, 2200]);
  const moveSeconds = `(10 / (1 + ${direction.build} * 1.5))`;
  // The operator's hands: steady in the calm, loose when the track pushes; a kick jolts the
  // rig forward and punches the lens, fading in a fifth of a second — only when it is loud.
  const handheld = `(0.6 + ${direction.energy} * ${direction.energy} * 4 + ${direction.build} * 2)`;
  const kickPunch = `(clamp(1 - op('kicks1').chan.kickCountSince * 5, 0, 1) ^ 2 * clamp((${direction.energy} - 0.45) / 0.4, 0, 1))`;
  const path =
    options.shot === undefined
      ? shotPath(facts, { index: options.cutIndex === undefined ? direction.shot : String(options.cutIndex), progress: options.cutIndex === undefined ? `${direction.since} / ${moveSeconds}` : `abstime / ${moveSeconds}`, time: "abstime", blockers: facts.blockers, shake: handheld, punch: kickPunch })
      : undefined;
  const previousPath =
    options.shot === undefined
      ? shotPath(facts, {
          index: options.cutIndex === undefined ? direction.previousShot : String(options.cutIndex),
          progress: options.cutIndex === undefined ? `${direction.previousSince} / ${moveSeconds}` : `(abstime - delta) / ${moveSeconds}`,
          time: "(abstime - delta)",
          blockers: facts.blockers,
          shake: handheld,
          punch: kickPunch,
        })
      : undefined;
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
  pointLight("furnace", "light.furnace_glow", [1, 0.6, 0.28], expressionSlot(`25 + ${direction.energy} * 60 + ${direction.build} * 40`, 50), -2400, 80);
  // Shadowed, so the arc flashes out of the slag door and the roof gaps, not through the shell.
  // Every range spans the hall: beyond its range a light is UNSHADOWED (T1362b), and an arc
  // flare leaking 40 m through the plant is what turned the caster violet.
  pointLight("arc", "light.arc", [0.6, 0.7, 1], expressionSlot(`60 + ${HIT("hatCount")} * 900 + ${direction.density} * 200 + sin(abstime * 37) * 30`, 90), -2200, 80);
  pointLight("slag", "light.slag_door", [1, 0.42, 0.12], expressionSlot(`35 + ${LEVEL("low")} * 40`, 45), -2000, 60);
  pointLight("tap", "light.tap", [1, 0.55, 0.2], expressionSlot(`30 + ${HIT("kickCount")} * 120`, 45), -1800, 50);
  pointLight("tundish", "light.tundish", [1, 0.5, 0.18], 45, -1600);
  // The high bays and floods are not forward lights: 65 fixtures light the frame from the
  // G-buffer in the deferred lamp pass (lamps.ts), below.

  const atmosphereScatter: Record<string, StoredParameter> = {};
  for (const light of SCATTER_LIGHTS) atmosphereScatter[light.param] = light.rest;
  atmosphereScatter["furnaceGlow"] = expressionSlot(`14 + ${LEVEL("low")} * 16`, 20);
  atmosphereScatter["slagGlow"] = 10;
  atmosphereScatter["tundishGlow"] = 8;
  atmosphereScatter["lampScatter"] = 0.8;
  // The sun is programmed with the windows: its shafts dim at rest, flare through a build and
  // go out at a section change.
  atmosphereScatter["sunShafts"] = expressionSlot(`(25 + ${direction.energy} ^ 2 * 80 + ${direction.build} * 140) * clamp(op('dirSections1').chan.noveltySince / 2 - 0.2, 0, 1)`, 80);
  atmosphereScatter["sunColor"] = [0.62, 0.86, 1, 1];
  atmosphereScatter["density"] = 0.009;
  // Low and cold: at a blackout this is all the smoke carries, and the camera must not
  // lift it into a beige wall (the exposure boost is capped at 3× for the same reason).
  atmosphereScatter["ambientSmoke"] = [0.0006, 0.0009, 0.0014];
  atmosphereScatter["arcFlash"] = expressionSlot(`6 + ${HIT("hatCount")} * 60`, 10);
  atmosphereScatter["tapGlow"] = expressionSlot(`10 + ${HIT("kickCount")} * 30`, 15);

  /** The sun's depth view (sun.ts): what the smoke asks before it lights a shaft. */
  const sun = sunView(facts, KEY_DIRECTION);
  const SUN_MAP = 2048;

  const cameraRef = (field: string, fallback: number): StoredParameter => expressionSlot(`op('cam1').par.${field}`, fallback);

  /** The fixtures as the lamp pass and the smoke both see them: one gain, the crane travel. */
  const lampDrive: Record<string, StoredParameter> = {
    gain: 0.003,
    // THE LIGHT PROGRAMME. The hall is near-black at rest — the melt and the slag carry the
    // frame — and the music switches it: the high bays rise with energy, strobe on alternate
    // beats through a build, and black out at a section change before fading back in.
    hall: expressionSlot(`(0.14 + 0.5 * ${direction.energy} ^ 2 + ${direction.build} * 0.6 * ((op('dirBeats1').chan.beatCount % 2) == 0)) * clamp(op('dirSections1').chan.noveltySince / 2 - 0.2, 0, 1)`, 0.1),
    crane: expressionSlot(`0.3 + ${HIT("hatCount")} * 2`, 0.3),
    furnace: expressionSlot(`0.3 + ${LEVEL("low")} * 1.2`, 0.5),
    catwalk: expressionSlot(`0.25 + ${direction.density} * 0.9`, 0.4),
    props: expressionSlot(`0.15 + ${direction.energy} * 0.5`, 0.2),
    failing: expressionSlot(`0.08 + ${direction.density} * 0.25`, 0.1),
    beaconRate: expressionSlot(`0.6 + ${direction.build} * 2`, 0.6),
    chase: expressionSlot(`clamp(${direction.build} * 1.5 - 0.3, 0, 1)`, 0),
    // The export's warm lamps retinted to neutral steel-blue (0.85, 0.9, 1): only the melt is warm.
    tint: [0.85, 1.05, 1.5, 1],
    craneX: expressionSlot("op('rig1').par.craneX", 0),
    crane2X: expressionSlot("op('rig1').par.crane2X", 0),
  };

  /**
   * The GLITCH BUDGET, a boundary: heavy glitching is allowed in every third section and
   * through a build-up; elsewhere it is damped to 30%, so the breaks are accents, not a coat.
   */
  const glitchBudget = `clamp(0.05 + 0.75 * ((op('dirSections1').chan.novelty % 3) == 1) + ${direction.build} * 0.6, 0, 1)`;
  /** How hard the track is pushing: nothing below a third of its range, full at the top. Every glitch scales by it. */
  const intensity = `clamp((${direction.energy} - 0.55) / 0.4, 0, 1)`;

  /** The camera now and one frame ago, as the screen-space passes that reproject read it. */
  const cameraNowAndBefore: Record<string, StoredParameter> = {
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
      prevEye: vec(eye),
      prevAim: aim,
      ...(previousPath === undefined
        ? {
            "prevEye.x": cameraRef("eye.x", eye[0]),
            "prevEye.y": cameraRef("eye.y", eye[1]),
            "prevEye.z": cameraRef("eye.z", eye[2]),
            "prevAim.x": cameraRef("lookAt.x", aim[0]),
            "prevAim.y": cameraRef("lookAt.y", aim[1]),
            "prevAim.z": cameraRef("lookAt.z", aim[2]),
            prevFov: cameraRef("fov", camera.fovDeg),
          }
        : {
            "prevEye.x": expressionSlot(previousPath.eye[0], eye[0]),
            "prevEye.y": expressionSlot(previousPath.eye[1], eye[1]),
            "prevEye.z": expressionSlot(previousPath.eye[2], eye[2]),
            "prevAim.x": expressionSlot(previousPath.aim[0], aim[0]),
            "prevAim.y": expressionSlot(previousPath.aim[1], aim[1]),
            "prevAim.z": expressionSlot(previousPath.aim[2], aim[2]),
            prevFov: expressionSlot(previousPath.fov, camera.fovDeg),
          }),
  };

  const nodes: GraphNode[] = [
    // ── Audio (a stand-in track until the song arrives) ──
    node("clip", "audioFileIn", [-4200, 1400], { file: options.audioUrl ?? "media/furnace/clankz3.wav", playMode: "timeline" }, { label: "clip1" }),
    node("pickLevels", "valueSelect", [-3900, 1300], { channels: "level low high" }, { label: "picklevels1" }),
    node("smooth", "valueLag", [-3600, 1300], { lag: 0.02, releaseRatio: 4 }, { label: "smooth1" }),
    node("rank", "valueNormalize", [-3300, 1300], { window: 16 }, { label: "rank1" }),
    // Fast attack, slow release: a level that rises late reads as the picture lagging the music.
    node("levels", "valueLag", [-3000, 1300], { lag: 0.03, releaseRatio: 5 }, { label: "levels1" }),
    node("pickHits", "valueSelect", [-3900, 1550], { channels: "kickCount snareCount hatCount" }, { label: "pickhits1" }),
    // Seconds since the last kick and snare, for the shockwave and the scanline on the steel.
    node("kickPick", "valueSelect", [-3900, 1750], { channels: "kickCount" }, { label: "kickpick1" }),
    node("kicks", "valueCount", [-3600, 1750], { threshold: 0.5, holdoff: 0.1 }, { label: "kicks1" }),
    node("snarePick", "valueSelect", [-3900, 1900], { channels: "snareCount" }, { label: "snarepick1" }),
    node("snares", "valueCount", [-3600, 1900], { threshold: 0.5, holdoff: 0.1 }, { label: "snares1" }),
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
    node("steel", "materialWgsl", [-3000, -600], { model: "pbr", source: PLANT_SURFACE_WGSL, heatGlow: 3.2, chalk: 0.12, soot: 0.38,
      fx: expressionSlot(`clamp((${direction.energy} - 0.4) / 0.5, 0, 1)`, 0),
      kickSince: expressionSlot("op('kicks1').chan.kickCountSince", 100),
      snareSince: expressionSlot("op('snares1').chan.snareCountSince", 100),
      flicker: expressionSlot(`${HIT("hatCount")} * (${direction.density} > 0.5)`, 0),
      heatPulse: expressionSlot(`${direction.energy} * 0.25 + ${direction.build} * 0.35`, 0.1) }, { label: "steel1" }),
    // The sky through the openings: emissive, unlit — so it neither shades nor casts (T666).
    node("sky", "meshFileIn", [-3600, -600], { file: facts.glbUrl, select: facts.sky.select, vertices: facts.sky.vertices, triangles: facts.sky.triangles, parts: facts.sky.parts }, { label: "sky1" }),
    // The windows are PROGRAMMED: their glow follows the light programme (dim at rest, a
    // flare through a build, black at a section change).
    node("skyMat", "materialWgsl", [-3300, -700], {
      model: "unlit",
      source: SKY_SURFACE_WGSL,
      sky: expressionSlot(`(0.1 + ${direction.energy} ^ 2 * 0.7 + ${direction.build} * 1.5 * ((op('dirBeats1').chan.beatCount % 2) == 0)) * clamp(op('dirSections1').chan.noveltySince / 2 - 0.2, 0, 1)`, 0.5),
    }, { label: "skymat1" }),
    node("skyGeo", "geometry", [-3000, -750], { mode: "surface", material: "skymat1" }, { label: "skygeo1" }),
    node("plantGeo", "geometry", [-3000, -300], { mode: "surface", material: "steel1" }, { label: "plantgeo1" }),
    node("machineGeo", "geometry", [-3000, 0], { mode: "surface", material: "steel1" }, { label: "machinegeo1" }),
    // ── Sparks ──
    node("sparks", "pointKernel", [-3300, 400], {
      capacity: 8000,
      attributes: SPARK_ATTRIBUTES,
      kernel: sparksKernel(facts),
      tapRate: expressionSlot(`0.05 + ${direction.build} * 0.35 + ${HIT("kickCount")} * 0.8`, 0.15),
      slagRate: 0.12,
      arcRate: expressionSlot(`0.03 + ${direction.density} * 0.15 + ${HIT("hatCount")} * 0.5`, 0.12),
      torchRate: 0.35,
      pourRate: expressionSlot("max(sin(abstime * 0.05), 0.0) * 0.6", 0),
      brightness: 28,
    }, { label: "sparks1" }),
    node("sparkMat", "materialUnlit", [-3000, 700], { color: [1, 1, 1, 1] }, { label: "sparkmat1" }),
    node("sparkGeo", "geometry", [-3000, 400], {
      mode: "beam",
      material: "sparkmat1",
      endpoint: "endpoint",
      blend: "additive",
      scale: 0.012,
      taper: 0.25,
      tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
    }, { label: "sparkgeo1" }),
    // ── Camera and light ──
    node("cam", "camera", [-2700, -900], {
      eye: vec(eye),
      lookAt: aim,
      fov: camera.fovDeg,
      near: 0.1,
      far: 400,
      ...(path === undefined
        ? { "eye.x": drift(0, 0.07, 0.35), "eye.y": drift(1, 0.05, 0.15), "eye.z": drift(2, 0.06, 0.3) }
        : {
            "eye.x": expressionSlot(path.eye[0], eye[0]),
            "eye.y": expressionSlot(path.eye[1], eye[1]),
            "eye.z": expressionSlot(path.eye[2], eye[2]),
            "lookAt.x": expressionSlot(path.aim[0], aim[0]),
            "lookAt.y": expressionSlot(path.aim[1], aim[1]),
            "lookAt.z": expressionSlot(path.aim[2], aim[2]),
            fov: expressionSlot(path.fov, camera.fovDeg),
          }),
    }, { label: "cam1" }),
    node("key", "light", [-2600, -900], {
      kind: "directional",
      direction: [KEY_DIRECTION[0], KEY_DIRECTION[1], KEY_DIRECTION[2]],
      // Daylight reads TEAL against the melt, never lavender: red held under green.
      color: [0.7, 0.88, 1, 1],
      intensity: 3.2,
      shadows: true,
      shadowExtent: 80,
      shadowSoftness: 1,
    }, { label: "key1" }),
    ...lightNodes,
    node("envSeed", "ramp", [-2700, 300], {}, { label: "envseed1", resolution: { mode: "fixed", width: 1024, height: 512 } }),
    node("env", "customWgsl", [-2700, 500], { source: SHOP_ENVIRONMENT_WGSL }, { label: "env1" }),
    // ── The sun's view: depth only, for the shafts ──
    node("sunCam", "camera", [-2700, 900], { eye: vec(sun.eye), lookAt: vec(sun.aim), ortho: true, orthoHeight: sun.height, near: sun.near, far: sun.far }, { label: "suncam1" }),
    node("sunMat", "materialUnlit", [-3300, 1100], { color: [1, 1, 1, 1] }, { label: "sunmat1" }),
    node("plantSun", "geometry", [-3000, 900], { mode: "surface", material: "sunmat1" }, { label: "plantsun1" }),
    node("machineSun", "geometry", [-3000, 1050], { mode: "surface", material: "sunmat1" }, { label: "machinesun1" }),
    node("sunShot", "render", [-2400, 900], { scenes: "plantsun1 machinesun1", camera: "suncam1", lights: "", depthOutput: true }, {
      label: "sunshot1",
      resolution: { mode: "fixed", width: SUN_MAP, height: Math.max(64, Math.round((SUN_MAP * sun.height) / sun.width)) },
    }),
    node("shot", "render", [-2400, 0], {
      scenes: "plantgeo1 skygeo1 machinegeo1 sparkgeo1",
      camera: "cam1",
      lights: ["key1", ...lightLabels].join(" "),
      ambientColor: [0.56, 0.58, 0.6, 1],
      ambientIntensity: 0.002,
      background: [0, 0, 0, 1],
      antialias: "msaa",
      depthOutput: true,
      normalOutput: true,
      albedoOutput: true,
      environmentIntensity: 0.2,
      environmentTaps: 12,
      ambientOcclusion: true,
      aoRadius: 0.8,
    }, { label: "shot1" }),
    // ── Air, bloom, grade ──
    // The fixtures, deferred on the G-buffer (T1371b/T1380b); then contact occlusion darkens
    // what they lit, then reflections, then air.
    node("lamps", "customWgslMulti", [-2250, 0], {
      source: lampsWgsl(fixturesOf(facts)),
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
      ...lampDrive,
    }, { label: "lamps1", resolution: { mode: "project" } }),
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
      source: atmosphereWgsl(facts, sun),
      ...atmosphereScatter,
      ...lampDrive,
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
    // Camera motion blur: the path one frame earlier is the previous camera (exact, stateless).
    node("shutter", "customWgslMulti", [-1200, 0], {
      source: MOTION_BLUR_WGSL,
      ...cameraNowAndBefore,
    }, { label: "shutter1", resolution: { mode: "project" } }),
    // The glitch layer (glitch.ts), after the grade, reading its own previous output and depth.
    node("glitch", "customWgslMulti", [600, 0], {
      source: GLITCH_WGSL,
      ...cameraNowAndBefore,
      // A cut moshes only when the music is pushing, never in the opening bars.
      mosh: expressionSlot(`clamp(1 - ${direction.since} / 0.45, 0, 1) * ${intensity} * ${intensity} * 0.7 * (abstime > 4)`, 0),
      tear: expressionSlot(`${glitchBudget} * ${intensity} * ${HIT("hatCount")} * (${direction.density} > 0.6) * ${direction.density}`, 0),
      split: expressionSlot(`${glitchBudget} * ${intensity} * (${HIT("snareCount")} * 0.6 + ${direction.build} * 0.2)`, 0),
      sort: expressionSlot(`${glitchBudget} * ${intensity} * ${direction.build} * 0.7`, 0),
      crush: expressionSlot(`${glitchBudget} * ${intensity} * (${direction.density} > 0.85) * ${HIT("kickCount")} * 0.5`, 0),
      freeze: expressionSlot(`(${direction.energy} > 0.92) * (${HIT("kickCount")} > 0.9) * ${glitchBudget}`, 0),
    }, { label: "glitch1", resolution: { mode: "project" } }),
    node("history", "feedback", [900, 300], { source: "glitch1" }, { label: "history1" }),
    node("bright", "customWgsl", [-1200, 300], { source: BRIGHT_PASS_WGSL, threshold: 4, knee: 1.5 }, { label: "bright1", resolution: { mode: "scale", factor: 0.5 } }),
    // The bloom PYRAMID (post.ts): four 13-tap downsamples, then tent upsamples back up,
    // each adding its own level — a round glow at every width, never a stretched texel.
    ...[1, 2, 3, 4].map((level) =>
      node(`bloomDown${level}`, "customWgsl", [-900, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, {
        label: `bloomdown${level}1`,
        resolution: { mode: "scale", factor: 0.5 / 2 ** level },
      }),
    ),
    ...[0, 1, 2, 3].map((level) =>
      node(`bloomUp${level}`, "customWgslMulti", [-600, 150 + level * 150], { source: BLOOM_UP_WGSL }, {
        label: `bloomup${level}1`,
        resolution: { mode: "scale", factor: 0.5 / 2 ** level },
      }),
    ),
    node("glow", "add", [-300, 0], { opacity: 0.05 }, { label: "glow1", resolution: { mode: "project" } }),
    // Auto-exposure (T1378b): meter the frame's log-average luminance, adapt toward a key
    // like an eye does — faster when the scene brightens than when it darkens — and hand the
    // grade the gain. One frame late by the meter's contract; the lag hides it.
    node("meter", "analyze", [-300, 300], { channel: "luminance", operation: "logAverage" }, { label: "meter1" }),
    node("metered", "channelIn", [0, 300], { channel: "meter1", fallback: 0.05 }, { label: "metered1" }),
    node("adaptation", "valueLag", [300, 300], { lag: 0.35, releaseRatio: 3 }, { label: "adaptation1" }),
    node("grade", "customWgsl", [0, 0], { source: GRADE_WGSL, exposure: -0.6, adapt: expressionSlot("clamp((0.075 / max(op('adaptation1').chan.value, 0.0005)) ^ 0.72, 0.03, 3)", 1), punch: 1.2, punchSaturation: 1.15, contrast: 1.05, grain: 0.016, saturation: 1.1, split: 0.3, shadowTint: [0.88, 0.98, 1.06, 1], highlightTint: [1.1, 1, 0.86, 1] }, { label: "grade1", resolution: { mode: "project" } }),
    node("out", "output", [300, 0], { toneMap: "none" }, { label: "out1" }),
    ...direction.nodes,
  ];

  const edges: GraphEdge[] = [
    edge("clip-levels", ["clip", "out"], ["pickLevels", "in"]),
    edge("levels-smooth", ["pickLevels", "out"], ["smooth", "in"]),
    edge("smooth-rank", ["smooth", "out"], ["rank", "in"]),
    edge("rank-levels", ["rank", "out"], ["levels", "in"]),
    edge("clip-hits", ["clip", "out"], ["pickHits", "in"]),
    edge("clip-kicks", ["clip", "out"], ["kickPick", "in"]),
    edge("kicks-count", ["kickPick", "out"], ["kicks", "in"]),
    edge("clip-snares", ["clip", "out"], ["snarePick", "in"]),
    edge("snares-count", ["snarePick", "out"], ["snares", "in"]),
    edge("hits-lag", ["pickHits", "out"], ["hits", "in"]),
    edge("seed-env", ["envSeed", "out"], ["env", "input"]),
    edge("env-shot", ["env", "out"], ["shot", "environment"]),
    edge("plant-geo", ["plant", "out"], ["plantGeo", "points"]),
    edge("machines-rig", ["machines", "out"], ["rig", "in"]),
    edge("rig-geo", ["rig", "out"], ["machineGeo", "points"]),
    edge("sparks-geo", ["sparks", "out"], ["sparkGeo", "points"]),
    edge("shot-lamps", ["shot", "out"], ["lamps", "input"]),
    edge("depth-lamps", ["shot", "depth"], ["lamps", "more"], 0),
    edge("normal-lamps", ["shot", "normal"], ["lamps", "more"], 1),
    edge("albedo-lamps", ["shot", "albedo"], ["lamps", "more"], 2),
    edge("lamps-occlusion", ["lamps", "out"], ["occlusion", "input"]),
    edge("depth-occlusion", ["shot", "depth"], ["occlusion", "more"], 0),
    edge("normal-occlusion", ["shot", "normal"], ["occlusion", "more"], 1),
    edge("occlusion-reflections", ["occlusion", "out"], ["reflections", "input"]),
    edge("depth-reflections", ["shot", "depth"], ["reflections", "more"], 0),
    edge("normal-reflections", ["shot", "normal"], ["reflections", "more"], 1),
    edge("reflections-air", ["reflections", "out"], ["air", "input"]),
    edge("depth-air", ["shot", "depth"], ["air", "more"], 0),
    edge("sun-air", ["sunShot", "depth"], ["air", "more"], 1),
    edge("plant-sun", ["plant", "out"], ["plantSun", "points"]),
    edge("sky-geo", ["sky", "out"], ["skyGeo", "points"]),
    edge("rig-sun", ["rig", "out"], ["machineSun", "points"]),
    edge("air-lens", ["air", "out"], ["lens", "input"]),
    edge("depth-lens", ["shot", "depth"], ["lens", "more"], 0),
    edge("lens-shutter", ["lens", "out"], ["shutter", "input"]),
    edge("depth-shutter", ["shot", "depth"], ["shutter", "more"], 0),
    edge("shutter-bright", ["shutter", "out"], ["bright", "input"]),
    ...[1, 2, 3, 4].map((level) =>
      edge(`bloom-down${level}`, [level === 1 ? "bright" : `bloomDown${level - 1}`, "out"], [`bloomDown${level}`, "input"]),
    ),
    ...[0, 1, 2, 3].flatMap((level) => [
      edge(`bloom-up${level}-lower`, [level === 3 ? "bloomDown4" : `bloomUp${level + 1}`, "out"], [`bloomUp${level}`, "input"]),
      edge(`bloom-up${level}-own`, [level === 0 ? "bright" : `bloomDown${level}`, "out"], [`bloomUp${level}`, "more"], 0),
    ]),
    // The bloom is the FRONT layer: Add's opacity scales in1, so it must be the glow, never the picture.
    edge("shutter-glow", ["shutter", "out"], ["glow", "in2"]),
    edge("sum-glow", ["bloomUp0", "out"], ["glow", "in1"]),
    edge("glow-grade", ["glow", "out"], ["grade", "input"]),
    edge("glow-meter", ["glow", "out"], ["meter", "input"]),
    edge("metered-adaptation", ["metered", "out"], ["adaptation", "in"]),
    edge("grade-glitch", ["grade", "out"], ["glitch", "input"]),
    edge("history-glitch", ["history", "out"], ["glitch", "more"], 0),
    edge("depth-glitch", ["shot", "depth"], ["glitch", "more"], 1),
    edge("glitch-out", ["glitch", "out"], ["out", "input"]),
    ...direction.edges,
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-furnace",
    name: "Furnace",
    graph: graph(nodes, edges),
    settings: settings({
      outputResolution: { width: options.width ?? 1920, height: options.height ?? 1080 },
      randomSeed: 11,
      // Many full-resolution HDR passes (G-buffer, screen space, bloom chain) at 1080p: the
      // default 1 GB texture budget is ~15% short, and this piece is made for a real GPU.
      limits: { ...LIMITS, memoryBudgetBytes: 3_221_225_472 },
    }),
    assets: [],
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
}
