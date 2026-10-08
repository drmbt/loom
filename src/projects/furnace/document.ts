import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import { bloomPyramidGraph } from "../../examples/bloom-pyramid.ts";
import type { FurnaceSceneFacts } from "./scene-facts.ts";
import { markerAt } from "./scene-facts.ts";
import { RIG_ATTRIBUTES, rigKernel } from "./rig-kernel.ts";
import { SPARK_ATTRIBUTES, sparksKernel } from "./sparks-kernel.ts";
import { SKY_SURFACE_WGSL, plantSurfaceWgsl } from "./surface-material.ts";
import { AIR_COMPOSITE_WGSL, KEY_DIRECTION, SCATTER_LIGHTS, atmosphereWgsl } from "./atmosphere.ts";
import { BLOOM_DOWN_WGSL } from "../../nodes/shaders/bloom-pyramid.wgsl.ts";
import { GRADE_WGSL } from "./post.ts";
import { SHOP_ENVIRONMENT_WGSL } from "./environment.ts";
import { DOF_WGSL, GTAO_WGSL, MOTION_BLUR_WGSL, SSR_WGSL } from "./screen-space.ts";
import { shotPath } from "./camera-path.ts";
import { GLITCH_WGSL } from "./glitch.ts";
import { SEGMENT_WGSL } from "./segments.ts";
import { GI_COMPOSITE_WGSL, SSGI_WGSL } from "./gi.ts";
import { TAA_WGSL } from "./taa.ts";
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
  /** 9:16 for social (T1385b): the lens widens so the tall frame holds what the wide one held across. */
  readonly portrait?: boolean;
  /** Hold one CUT entry and play its move from t = 0 (the director still drives everything else): previewing a framing. */
  readonly cutIndex?: number;
  /** The track, as a path under public/. Absent: the owner's working track (Clankz 3), which build.ts copies there. */
  readonly audioUrl?: string;
}

/** Parameters may be slots (expressions, maps); the shared builder's signature takes values only. */
function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const HIT = (channel: string): string => `op('lag_hits').chan.${channel}`;
const LEVEL = (channel: string): string => `op('lag_levels').chan.${channel}`;

function vec(value: readonly [number, number, number]): number[] {
  return [value[0], value[1], value[2]];
}

/**
 * Portrait lens: tan(v′/2) = tan(v/2) · 16/9 — the tall frame sees vertically what the wide
 * frame saw across. The expression engine has sin and cos but no tan or atan: tan is sin/cos,
 * and atan is the two-piece fit x·π/4 + 0.273·x·(1 − x) on [0, 1], π/2 − atan(1/x) above.
 */
const PORTRAIT_STRETCH = 16 / 9;
function portraitFovExpression(fov: string): string {
  const half = `((${fov}) * 0.00872665)`;
  const x = `(sin(${half}) / cos(${half}) * ${PORTRAIT_STRETCH.toFixed(6)})`;
  const low = `(${x} * 0.785398 + 0.273 * ${x} * (1 - ${x}))`;
  const inv = `(1 / max(${x}, 1e-3))`;
  const high = `(1.570796 - (${inv} * 0.785398 + 0.273 * ${inv} * (1 - ${inv})))`;
  return `(114.591559 * ((${x} <= 1) * ${low} + (${x} > 1) * ${high}))`;
}

export function furnaceDocument(facts: FurnaceSceneFacts, options: FurnaceDocumentOptions): ProjectDocument {
  const portraitFov = (degrees: number): number =>
    options.portrait === true ? (2 * Math.atan(Math.tan((degrees * Math.PI) / 360) * PORTRAIT_STRETCH) * 180) / Math.PI : degrees;
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
  /**
   * The ARC: acts counted by section changes (0 → 1 over the first five). The film starts
   * restrained and gets wilder — rougher hands, more glitch, louder steel — so the song's
   * shape reads in the picture, not only its beats.
   */
  const act = "clamp(op('count_dirSections').chan.novelty / 5, 0, 1)";
  const handheld = `((0.6 + ${direction.energy} * ${direction.energy} * 4 + ${direction.build} * 2) * (1 + ${act}))`;
  const kickPunch = `(clamp(1 - op('count_kicks').chan.kickCountSince * 5, 0, 1) ^ 2 * (0.35 + 0.65 * clamp((${direction.energy} - 0.3) / 0.4, 0, 1)))`;
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
      }, { label: `light_${label}` }),
    );
    lightLabels.push(`light_${label}`);
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
  // The full ladle is a light source: it throws orange up its rim, over the car and the floor.
  pointLight("ladle", "emit.ladle_surface", [1, 0.5, 0.15], expressionSlot(`30 + ${LEVEL("low")} * 25`, 40), -1700);
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
  atmosphereScatter["sunShafts"] = expressionSlot(`(90 + ${direction.energy} * 70 + ${direction.build} * 140) * clamp(op('count_dirSections').chan.noveltySince / 2 - 0.2, 0, 1)`, 80);
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

  const cameraRef = (field: string, fallback: number): StoredParameter => expressionSlot(`op('camera1').par.${field}`, fallback);

  /** The fixtures as the lamp pass and the smoke both see them: one gain, the crane travel. */
  const lampDrive: Record<string, StoredParameter> = {
    gain: 0.003,
    // THE LIGHT PROGRAMME. The hall is near-black at rest — the melt and the slag carry the
    // frame — and the music switches it: the high bays rise with energy, strobe on alternate
    // beats through a build, and black out at a section change before fading back in.
    // …and every kick flashes the bays, at any energy: the hall breathes with the beat.
    hall: expressionSlot(`(0.14 + ${HIT("kickCount")} * 0.35 + 0.5 * ${direction.energy} ^ 2 + ${direction.build} * 0.6 * ((op('count_dirBeats').chan.beatCount % 2) == 0)) * clamp(op('count_dirSections').chan.noveltySince / 2 - 0.2, 0, 1)`, 0.1),
    crane: expressionSlot(`0.3 + ${HIT("hatCount")} * 2`, 0.3),
    furnace: expressionSlot(`0.3 + ${LEVEL("low")} * 1.2`, 0.5),
    catwalk: expressionSlot(`0.25 + ${direction.density} * 0.9`, 0.4),
    props: expressionSlot(`0.15 + ${direction.energy} * 0.5`, 0.2),
    failing: expressionSlot(`0.08 + ${direction.density} * 0.25`, 0.1),
    beaconRate: expressionSlot(`0.6 + ${direction.build} * 2`, 0.6),
    chase: expressionSlot(`clamp(${direction.build} * 1.5 - 0.3, 0, 1)`, 0),
    // The export's warm lamps retinted to neutral steel-blue (0.85, 0.9, 1): only the melt is warm.
    tint: [0.9, 0.95, 1.35, 1],
    craneX: expressionSlot("op('kernel_rig').par.craneX", 0),
    crane2X: expressionSlot("op('kernel_rig').par.crane2X", 0),
  };

  /**
   * The GLITCH BUDGET, a boundary: heavy glitching is allowed in every third section and
   * through a build-up; elsewhere it is damped to 30%, so the breaks are accents, not a coat.
   */
  const glitchBudget = `clamp(0.05 + 0.75 * ((op('count_dirSections').chan.novelty % 3) == 1) + ${direction.build} * 0.6, 0, 1)`;
  /** How hard the track is pushing: nothing below a third of its range, full at the top. Every glitch scales by it. */
  const intensity = `clamp((${direction.energy} - 0.35) / 0.45 + ${act} * 0.2, 0, 1)`;
  /** RARE BURSTS: half a second of hard glitch at a section change, and on a kick at a loud peak — sprinkled, never a coat. */
  const burst = `clamp((op('count_dirSections').chan.noveltySince < 1) + (${direction.energy} > 0.7) * (${HIT("kickCount")} > 0.9) * (op('count_dirCuts').chan.cut % 2 == 0) * (0.5 + ${act}), 0, 1)`;

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
      roll: cameraRef("roll", 0),
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
            prevRoll: cameraRef("roll", 0),
          }
        : {
            "prevEye.x": expressionSlot(previousPath.eye[0], eye[0]),
            "prevEye.y": expressionSlot(previousPath.eye[1], eye[1]),
            "prevEye.z": expressionSlot(previousPath.eye[2], eye[2]),
            "prevAim.x": expressionSlot(previousPath.aim[0], aim[0]),
            "prevAim.y": expressionSlot(previousPath.aim[1], aim[1]),
            "prevAim.z": expressionSlot(previousPath.aim[2], aim[2]),
            // The previous lens must be the SAME lens: a landscape fov here read as a zoom and smeared every pixel.
            prevFov: expressionSlot(options.portrait === true ? portraitFovExpression(previousPath.fov) : previousPath.fov, portraitFov(camera.fovDeg)),
            prevRoll: expressionSlot(previousPath.roll, 0),
          }),
  };

  const bloom = bloomPyramidGraph({
    ids: { bright: "bright", down: ["bloomDown1", "bloomDown2", "bloomDown3", "bloomDown4"], up: ["bloomUp0", "bloomUp1", "bloomUp2", "bloomUp3"] },
    edgePrefix: "bloom",
    layout: { bright: [-1200, 300], down: [-900, 300], up: [-600, 150], step: [0, 150] },
    threshold: 2, knee: 1.5, firstClampLuma: 1, lower: 1,
  });
  const nodes: GraphNode[] = [
    // ── Audio (a stand-in track until the song arrives) ──
    node("clip", "audioFileIn", [-4200, 1400], { file: options.audioUrl ?? "media/furnace/clankz3.wav", playMode: "timeline" }, { label: "audiofile_clip" }),
    node("pickLevels", "valueSelect", [-3900, 1300], { channels: "level low high" }, { label: "select_picklevels" }),
    node("smooth", "valueLag", [-3600, 1300], { lag: 0.02, releaseRatio: 4 }, { label: "lag_smooth" }),
    node("rank", "valueNormalize", [-3300, 1300], { window: 16 }, { label: "normalize_rank" }),
    // Fast attack, slow release: a level that rises late reads as the picture lagging the music.
    node("levels", "valueLag", [-3000, 1300], { lag: 0.03, releaseRatio: 5 }, { label: "lag_levels" }),
    node("pickHits", "valueSelect", [-3900, 1550], { channels: "kickCount snareCount hatCount" }, { label: "select_pickhits" }),
    // Seconds since the last kick and snare, for the shockwave and the scanline on the steel.
    node("kickPick", "valueSelect", [-3900, 1750], { channels: "kickCount" }, { label: "select_kickpick" }),
    node("kicks", "valueCount", [-3600, 1750], { threshold: 0.5, holdoff: 0.1 }, { label: "count_kicks" }),
    node("snarePick", "valueSelect", [-3900, 1900], { channels: "snareCount" }, { label: "select_snarepick" }),
    node("snares", "valueCount", [-3600, 1900], { threshold: 0.5, holdoff: 0.1 }, { label: "count_snares" }),
    node("hits", "valueLag", [-3600, 1550], { lag: 0.001, releaseRatio: 250 }, { label: "lag_hits" }),
    // ── The shop ──
    node("plant", "meshFileIn", [-3600, -300], { file: facts.glbUrl, select: facts.plant.select, vertices: facts.plant.vertices, triangles: facts.plant.triangles, parts: facts.plant.parts }, { label: "mesh_plant" }),
    node("machines", "meshFileIn", [-3600, 0], { file: facts.glbUrl, select: facts.machines.select, vertices: facts.machines.vertices, triangles: facts.machines.triangles, parts: facts.machines.parts }, { label: "mesh_machines" }),
    node("rig", "pointKernel", [-3300, 0], {
      capacity: facts.machines.vertices,
      attributes: RIG_ATTRIBUTES,
      kernel: rigKernel(facts),
      // The shop at work, slowly: the scrap crane crosses the bay, the ladle crane waits,
      // the electrodes hunt with the snare, the belt and the strand run.
      // The scrap crane works the SCRAP BAY (bridge 9.5–19.5 m from the furnace), bucket held
      // high: sweeping it over the furnace with the hook down dragged it through the roof,
      // the fume duct and the columns.
      craneX: expressionSlot("-4 + sin(abstime * 0.045) * 5", -4),
      trolley: expressionSlot("sin(abstime * 0.07 + 1.3) * 2.5", 0),
      hook: expressionSlot("sin(abstime * 0.11) * 0.4", 0),
      bucketSway: expressionSlot("sin(abstime * 0.9) * 0.015", 0),
      crane2X: expressionSlot("sin(abstime * 0.03 + 2.0) * 6", 0),
      hook2: expressionSlot("-1 + sin(abstime * 0.09) * 1.2", -1),
      // The electrodes PUMP: they drive into the bath and kick back up on the beat.
      electrode1: expressionSlot(`-0.45 + ${HIT("kickCount")} * 0.45 + ${HIT("snareCount")} * 0.2 + sin(abstime * 3.1) * 0.05`, -0.45),
      electrode2: expressionSlot(`-0.4 + ${HIT("kickCount")} * 0.35 + ${HIT("hatCount")} * 0.15 + sin(abstime * 2.7 + 1.0) * 0.05`, -0.4),
      electrode3: expressionSlot(`-0.5 + ${HIT("kickCount")} * 0.4 + ${HIT("snareCount")} * 0.25 + sin(abstime * 3.4 + 2.0) * 0.05`, -0.5),
      ladleTilt: expressionSlot("max(sin(abstime * 0.05), 0.0) * 0.35", 0),
      casting: expressionSlot("abstime * 0.4", 0),
      conveyor: expressionSlot("abstime * 1.2", 0),
    }, { label: "kernel_rig" }),
    node("steel", "materialWgsl", [-3000, -600], { model: "pbr", source: plantSurfaceWgsl(facts), heatGlow: 3.2, liquidGlow: 2.2, liningGlow: 24, arcGlow: expressionSlot(`1.6 + ${direction.density} * 1.2 + ${HIT("hatCount")} * 3`, 2), arcFlash: expressionSlot(`${HIT("hatCount")} * 6 + ${direction.density} * 0.5`, 0), fire: expressionSlot(`5 + ${LEVEL("low")} * 12 + ${direction.build} * 10`, 9), chalk: 0.12, soot: 0.38,
      // The steel answers every kick and snare, loud or quiet: a floor of 0.4 even in the calm.
      fx: expressionSlot(`0.25 + 0.35 * ${act} + 0.5 * clamp((${direction.energy} - 0.3) / 0.5, 0, 1)`, 0.3),
      kickSince: expressionSlot("op('count_kicks').chan.kickCountSince", 100),
      snareSince: expressionSlot("op('count_snares').chan.snareCountSince", 100),
      kickCount: expressionSlot("op('count_kicks').chan.kickCount", 0),
      beltTravel: expressionSlot("op('kernel_rig').par.conveyor", 0),
      lampHall: expressionSlot("op('wgsl_lamps').par.hall", 1),
      lampProps: expressionSlot("op('wgsl_lamps').par.props", 1),
      lampChase: expressionSlot("op('wgsl_lamps').par.chase", 0),
      lampFailing: expressionSlot("op('wgsl_lamps').par.failing", 0.1),
      snareCount: expressionSlot("op('count_snares').chan.snareCount", 0),
      flicker: expressionSlot(`${HIT("hatCount")} * (${direction.density} > 0.5)`, 0),
      heatPulse: expressionSlot(`${direction.energy} * 0.25 + ${direction.build} * 0.35`, 0.1) }, { label: "material_steel" }),
    // The sky through the openings: emissive, unlit — so it neither shades nor casts (T666).
    node("sky", "meshFileIn", [-3600, -600], { file: facts.glbUrl, select: facts.sky.select, vertices: facts.sky.vertices, triangles: facts.sky.triangles, parts: facts.sky.parts }, { label: "mesh_sky" }),
    // The windows are PROGRAMMED: their glow follows the light programme (dim at rest, a
    // flare through a build, black at a section change).
    node("skyMat", "materialWgsl", [-3300, -700], {
      model: "unlit",
      source: SKY_SURFACE_WGSL,
      sky: expressionSlot(`(0.1 + ${direction.energy} ^ 2 * 0.7 + ${direction.build} * 1.5 * ((op('count_dirBeats').chan.beatCount % 2) == 0)) * clamp(op('count_dirSections').chan.noveltySince / 2 - 0.2, 0, 1)`, 0.5),
      chase: expressionSlot(`clamp(${direction.build} * 1.5 - 0.2, 0, 1)`, 0),
      strobe: expressionSlot(`${HIT("snareCount")} * clamp((${direction.energy} - 0.35) / 0.4, 0, 1)`, 0),
      pick: expressionSlot("op('count_kicks').chan.kickCount", 0),
      warm: expressionSlot(`clamp((${direction.energy} - 0.75) / 0.2, 0, 1) * 0.7`, 0),
    }, { label: "material_sky" }),
    node("skyGeo", "geometry", [-3000, -750], { mode: "surface", material: "material_sky" }, { label: "geometry_sky" }),
    node("plantGeo", "geometry", [-3000, -300], { mode: "surface", material: "material_steel" }, { label: "geometry_plant" }),
    node("machineGeo", "geometry", [-3000, 0], { mode: "surface", material: "material_steel" }, { label: "geometry_machine" }),
    // ── Sparks ──
    node("sparks", "pointKernel", [-3300, 400], {
      capacity: 8000,
      attributes: SPARK_ATTRIBUTES,
      kernel: sparksKernel(facts),
      tapRate: expressionSlot(`0.05 + ${direction.build} * 0.35 + ${HIT("kickCount")} * 0.8`, 0.15),
      // The oxygen lance never stops cutting: a steady spray, bursting on kicks.
      slagRate: expressionSlot(`0.25 + ${HIT("kickCount")} * 0.6 + ${direction.energy} * 0.2`, 0.3),
      arcRate: expressionSlot(`0.03 + ${direction.density} * 0.15 + ${HIT("hatCount")} * 0.5`, 0.12),
      torchRate: 0.35,
      // No pour stream exists yet (T1386b): a spray from the lip would come out of nothing.
      pourRate: 0,
      brightness: expressionSlot(`28 * (0.7 + 0.6 * ${act})`, 28),
    }, { label: "kernel_sparks" }),
    node("sparkMat", "materialUnlit", [-3000, 700], { color: [1, 1, 1, 1] }, { label: "material_spark" }),
    node("sparkGeo", "geometry", [-3000, 400], {
      mode: "beam",
      material: "material_spark",
      endpoint: "endpoint",
      blend: "additive",
      scale: 0.012,
      taper: 0.25,
      tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
    }, { label: "geometry_spark" }),
    // ── Camera and light ──
    node("cam", "camera", [-2700, -900], {
      eye: vec(eye),
      lookAt: aim,
      fov: portraitFov(camera.fovDeg),
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
            fov: expressionSlot(options.portrait === true ? portraitFovExpression(path.fov) : path.fov, portraitFov(camera.fovDeg)),
            roll: expressionSlot(path.roll, 0),
          }),
    }, { label: "camera1" }),
    node("key", "light", [-2600, -900], {
      kind: "directional",
      direction: [KEY_DIRECTION[0], KEY_DIRECTION[1], KEY_DIRECTION[2]],
      // Daylight reads TEAL against the melt, never lavender: red held under green.
      color: [0.7, 0.88, 1, 1],
      intensity: 3.2,
      shadows: true,
      shadowExtent: 80,
      shadowSoftness: 1,
    }, { label: "light_key" }),
    ...lightNodes,
    node("envSeed", "ramp", [-2700, 300], {}, { label: "ramp_envseed", resolution: { mode: "fixed", width: 1024, height: 512 } }),
    node("env", "customWgsl", [-2700, 500], { source: SHOP_ENVIRONMENT_WGSL }, { label: "wgsl_env" }),
    // ── The sun's view: depth only, for the shafts ──
    node("sunCam", "camera", [-2700, 900], { eye: vec(sun.eye), lookAt: vec(sun.aim), ortho: true, orthoHeight: sun.height, near: sun.near, far: sun.far }, { label: "camera_sun" }),
    node("sunMat", "materialUnlit", [-3300, 1100], { color: [1, 1, 1, 1] }, { label: "material_sun" }),
    node("plantSun", "geometry", [-3000, 900], { mode: "surface", material: "material_sun" }, { label: "geometry_plantsun" }),
    node("machineSun", "geometry", [-3000, 1050], { mode: "surface", material: "material_sun" }, { label: "geometry_machinesun" }),
    node("sunShot", "render", [-2400, 900], { scenes: "geometry_plantsun geometry_machinesun", camera: "camera_sun", lights: "", depthOutput: true }, {
      label: "render_sunshot",
      resolution: { mode: "fixed", width: SUN_MAP, height: Math.max(64, Math.round((SUN_MAP * sun.height) / sun.width)) },
    }),
    node("shot", "render", [-2400, 0], {
      scenes: "geometry_plant geometry_sky geometry_machine geometry_spark",
      camera: "camera1",
      lights: ["light_key", ...lightLabels].join(" "),
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
    }, { label: "render_shot" }),
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
      roll: cameraRef("roll", 0),
      ...lampDrive,
    }, { label: "wgsl_lamps", resolution: { mode: "project" } }),
    // Screen space on the G-buffer (T1371b): contact occlusion, then reflections, then air.
    // GI (gi.ts): the lit frame at quarter size is the light source for one bounce — hot
    // things light what is around them. Gathered at half size, blurred, added at full size.
    node("litQuarter", "customWgsl", [-2250, 250], { source: BLOOM_DOWN_WGSL, clampLuma: 1 }, { label: "wgsl_litquarter", resolution: { mode: "scale", factor: 0.25 } }),
    node("gather", "customWgslMulti", [-2200, 350], {
      source: SSGI_WGSL,
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
      roll: cameraRef("roll", 0),
      radius: 9,
      strength: 20,
    }, { label: "wgsl_gather", resolution: { mode: "scale", factor: 0.5 } }),
    node("gatherBlur", "blur", [-2150, 450], { size: 4, filter: "gaussian", extend: "hold" }, { label: "blur_gather", resolution: { mode: "scale", factor: 0.5 } }),
    node("bounce", "customWgslMulti", [-2150, 0], { source: GI_COMPOSITE_WGSL, amount: 1 }, { label: "wgsl_bounce", resolution: { mode: "project" } }),
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
      roll: cameraRef("roll", 0),
    }, { label: "wgsl_occlusion", resolution: { mode: "project" } }),
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
      roll: cameraRef("roll", 0),
    }, { label: "wgsl_reflections", resolution: { mode: "project" } }),
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
      roll: cameraRef("roll", 0),
    }, { label: "wgsl_air", resolution: { mode: "scale", factor: 0.5 } }),
    node("airComposite", "customWgslMulti", [-1450, 150], { source: AIR_COMPOSITE_WGSL }, { label: "wgsl_aircomposite", resolution: { mode: "project" } }),
    node("lens", "customWgslMulti", [-1350, 0], {
      source: DOF_WGSL,
      // In PIXELS per unit defocus: the tall frame is narrower, so the same number blurred more of it.
      aperture: options.portrait === true ? 0.3 : 0.48,
      maxRadius: 22,
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
      roll: cameraRef("roll", 0),
    }, { label: "wgsl_lens", resolution: { mode: "project" } }),
    // Camera motion blur: the path one frame earlier is the previous camera (exact, stateless).
    // TAA (taa.ts): the history reprojected through last frame's camera, clamped, blended.
    node("taa", "customWgslMulti", [-1400, 150], {
      source: TAA_WGSL,
      ...cameraNowAndBefore,
      reset: expressionSlot("op('count_dirCuts').chan.cutSince < 0.05", 0),
    }, { label: "wgsl_taa", resolution: { mode: "project" } }),
    node("taaHistory", "feedback", [-1400, 300], { source: "wgsl_taa" }, { label: "feedback_taahistory" }),
    node("shutter", "customWgslMulti", [-1200, 0], {
      source: MOTION_BLUR_WGSL,
      ...cameraNowAndBefore,
    }, { label: "wgsl_shutter", resolution: { mode: "project" } }),
    // The glitch layer (glitch.ts), after the grade, reading its own previous output and depth.
    // The SEGMENT FILTER (segments.ts): in one section of every three a slab of the hall is
    // re-drawn — wireframe, mono-with-reds, or thermal — drifting along the hall, fixed to the
    // plant as the camera moves. Taste over noise: it only runs in its sections.
    node("segments", "customWgslMulti", [450, 0], {
      source: SEGMENT_WGSL,
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
      roll: cameraRef("roll", 0),
      amount: expressionSlot(`((op('count_dirSections').chan.novelty % 3) == 2) * clamp(0.55 + ${act} * 0.3 + ${direction.build} * 0.4, 0, 1) * clamp(op('count_dirSections').chan.noveltySince / 1.5, 0, 1)`, 0),
      mode: expressionSlot("floor(op('count_dirSections').chan.novelty / 3) % 3", 0),
      centre: expressionSlot("-45 + 90 * fract(abstime * 0.02 + op('count_dirSections').chan.novelty * 0.37)", 0),
      width: expressionSlot(`10 + ${direction.energy} * 22`, 16),
      edgeColour: [1, 0.12, 0.04, 1],
    }, { label: "wgsl_segments", resolution: { mode: "project" } }),
    node("glitch", "customWgslMulti", [600, 0], {
      source: GLITCH_WGSL,
      ...cameraNowAndBefore,
      // A cut moshes only when the music is pushing, never in the opening bars.
      mosh: expressionSlot(`clamp(1 - ${direction.since} / 0.45, 0, 1) * ${intensity} * ${intensity} * 0.7 * (abstime > 4)`, 0),
      tear: expressionSlot(`(${glitchBudget} * ${intensity} + ${burst}) * ${HIT("hatCount")} * (${direction.density} > 0.6) * ${direction.density}`, 0),
      split: expressionSlot(`(${glitchBudget} * ${intensity} + ${burst} * 1.5) * (${HIT("snareCount")} * 0.6 + ${direction.build} * 0.2)`, 0),
      sort: expressionSlot(`${glitchBudget} * ${intensity} * ${direction.build} * 0.7`, 0),
      crush: expressionSlot(`${burst} * 0.6 + ${glitchBudget} * ${intensity} * (${direction.density} > 0.85) * ${HIT("kickCount")} * 0.5`, 0),
      freeze: expressionSlot(`(${direction.energy} > 0.92) * (${HIT("kickCount")} > 0.9) * ${glitchBudget}`, 0),
    }, { label: "wgsl_glitch", resolution: { mode: "project" } }),
    node("history", "feedback", [900, 300], { source: "wgsl_glitch" }, { label: "feedback_history" }),
    ...bloom.nodes,
    node("glow", "add", [-300, 0], { opacity: 0.35 }, { label: "add_glow", resolution: { mode: "project" } }),
    // Auto-exposure (T1378b): meter the frame's log-average luminance, adapt toward a key
    // like an eye does — faster when the scene brightens than when it darkens — and hand the
    // grade the gain. One frame late by the meter's contract; the lag hides it.
    node("meter", "analyze", [-300, 300], { channel: "luminance", operation: "logAverage" }, { label: "analyze_meter" }),
    node("metered", "channelIn", [0, 300], { channel: "analyze_meter", fallback: 0.05 }, { label: "channelin_metered" }),
    node("adaptation", "valueLag", [300, 300], { lag: 0.35, releaseRatio: 3 }, { label: "lag_adaptation" }),
    node("grade", "customWgsl", [0, 0], { source: GRADE_WGSL, exposure: -0.6, adapt: expressionSlot("clamp((0.075 / max(op('lag_adaptation').chan.value, 0.0005)) ^ 0.72, 0.03, 3)", 1), punch: 1.3, punchSaturation: 1.2, contrast: 1.15, grain: 0.016, saturation: expressionSlot(`1.0 + 0.3 * ${act}`, 1.1), split: 0.3, shadowTint: [0.88, 0.98, 1.06, 1], highlightTint: [1.1, 1, 0.86, 1] }, { label: "wgsl_grade", resolution: { mode: "project" } }),
    node("out", "output", [300, 0], { toneMap: "none" }, { label: "output1" }),
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
    edge("lamps-quarter", ["lamps", "out"], ["litQuarter", "input"]),
    edge("quarter-gather", ["litQuarter", "out"], ["gather", "input"]),
    edge("depth-gather", ["shot", "depth"], ["gather", "more"], 0),
    edge("normal-gather", ["shot", "normal"], ["gather", "more"], 1),
    edge("gather-blur", ["gather", "out"], ["gatherBlur", "input"]),
    edge("lamps-bounce", ["lamps", "out"], ["bounce", "input"]),
    edge("blur-bounce", ["gatherBlur", "out"], ["bounce", "more"], 0),
    edge("albedo-bounce", ["shot", "albedo"], ["bounce", "more"], 1),
    edge("bounce-occlusion", ["bounce", "out"], ["occlusion", "input"]),
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
    edge("reflections-composite", ["reflections", "out"], ["airComposite", "input"]),
    edge("air-composite", ["air", "out"], ["airComposite", "more"], 0),
    edge("composite-taa", ["airComposite", "out"], ["taa", "input"]),
    edge("depth-taa", ["shot", "depth"], ["taa", "more"], 0),
    edge("history-taa", ["taaHistory", "out"], ["taa", "more"], 1),
    edge("taa-lens", ["taa", "out"], ["lens", "input"]),
    edge("depth-lens", ["shot", "depth"], ["lens", "more"], 0),
    edge("lens-shutter", ["lens", "out"], ["shutter", "input"]),
    edge("depth-shutter", ["shot", "depth"], ["shutter", "more"], 0),
    edge("shutter-bright", ["shutter", "out"], ["bright", "input"]),
    ...bloom.edges,
    // The bloom is the FRONT layer: Add's opacity scales in1, so it must be the glow, never the picture.
    edge("shutter-glow", ["shutter", "out"], ["glow", "in2"]),
    edge("sum-glow", ["bloomUp0", "out"], ["glow", "in1"]),
    edge("glow-grade", ["glow", "out"], ["grade", "input"]),
    edge("glow-meter", ["glow", "out"], ["meter", "input"]),
    edge("metered-adaptation", ["metered", "out"], ["adaptation", "in"]),
    edge("grade-segments", ["grade", "out"], ["segments", "input"]),
    edge("depth-segments", ["shot", "depth"], ["segments", "more"], 0),
    edge("normal-segments", ["shot", "normal"], ["segments", "more"], 1),
    edge("segments-glitch", ["segments", "out"], ["glitch", "input"]),
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
