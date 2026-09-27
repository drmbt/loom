import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../furnace/post.ts";
import { DOF_WGSL, GTAO_WGSL } from "../furnace/screen-space.ts";
import { GLOSSY_SSR_WGSL } from "./reflections.ts";
import { ENVIRONMENT_HDRI_WGSL, ENVIRONMENT_WGSL, HEADLIGHT_COOKIE_WGSL, hazeLights, hazeWgsl } from "./atmosphere.ts";
import { CRT_WGSL, ECHO_WGSL, GRADE_WGSL, HALO_WGSL, LENS_WGSL, MIRROR_WGSL, OPTICS_COMPOSITE_WGSL, STREAK_WGSL } from "./fx.ts";
import type { Area, OnNothingFacts } from "./scene-facts.ts";
import { carAreas } from "./scene-facts.ts";
import { markerOf } from "./scene-facts.ts";
import { SKIN_ATTRIBUTES, boneParam, skinKernel, yawFor } from "./skin-kernel.ts";
import { LAMP_GLASS_WGSL, surfaceWgsl, type Footprint } from "./surface.ts";
import { CAR_RIG_ATTRIBUTES, carRigKernel } from "./car-rig.ts";
import { WHEEL_DOF, WHEEL_DRIVE, WHEEL_GRADE, WHEEL_SSR, WHEEL_TURN, WHEEL_GLYPHS, WHEEL_GLYPHS_WGSL, placedHaze, riding, wheelCamera, wheelLights, wheelRig } from "./shots/wheel.ts";
import { titleDocument } from "./shots/title.ts";
import { ringDocument } from "./shots/ring.ts";
import { prismDocument } from "./shots/prism.ts";
import { haloDocument } from "./shots/halo.ts";
import { crtDocument } from "./shots/crt.ts";
import { cycDocument } from "./shots/cyc.ts";
import { quadDocument } from "./shots/quad.ts";
import { handheld } from "./shots/handheld.ts";
import { CLOSEUP_SHOTS, closeupDocument, isCloseup } from "./shots/closeups.ts";
import { splitDocument } from "./shots/split.ts";
import { mirrorDocument } from "./shots/mirror.ts";
import { lightsDocument } from "./shots/lights.ts";
import { incarDocument } from "./shots/incar.ts";
import { REACT_PROFILES, reactive } from "./shots/react.ts";

/**
 * T1400b — THE ON NOTHING DOCUMENTS: one graph per shot, built from the GLB's measured facts.
 *
 * Every shot runs the same chain — Render (G-buffer) → reflections → contact occlusion →
 * haze → [depth of field] → the optics (streak columns, halo rings, bloom) → lens → grade →
 * [echo] → [mirror tiles] → [CRT] → Output — and differs in what it draws, how it is lit,
 * what the figure does and which finishing layers run. See
 * docs/on-nothing-shots-plan-2026-09-27.md for what each shot is after.
 */

/** The close-ups (shots/closeups.ts) are their own graphs. */
export const SHOTS = ["tableau", "title", "ring", "quad", "cyc", "cyc-wide", "zoom", "prism", "wheel", "halo", "crt", "split", "mirror", "lights", "incar", ...CLOSEUP_SHOTS] as const;
export type Shot = (typeof SHOTS)[number];
/** The four sets; `zoom` and `prism` are the tableau's set with their own camera and finish. */
type Base = "tableau" | "title" | "quad" | "cyc" | "wheel";
const BASE_OF: Record<Exclude<Shot, (typeof CLOSEUP_SHOTS)[number]>, Base> = { tableau: "tableau", title: "title", ring: "quad", quad: "quad", cyc: "cyc", "cyc-wide": "cyc", zoom: "tableau", prism: "tableau", wheel: "wheel", halo: "tableau", crt: "tableau", split: "tableau", mirror: "cyc", lights: "tableau", incar: "tableau" };

export interface OnNothingOptions {
  readonly shot: Shot;
  /** Which take: a shot may frame its set several ways (the EDL's rows pick one; 0 = the first). */
  readonly take?: number;
  readonly width?: number;
  readonly height?: number;
  /** Run the CRT re-scan over the finished frame. */
  readonly crt?: boolean;
  /** Hear the song: an Audio File In (timeline) whose level lanes drive the streaks. */
  readonly audio?: boolean;
  /** Light reflections from a real HDRI (a Movie File In `hdri`, fed RGBM; see hdri.ts). */
  readonly hdri?: boolean;
}

function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const vec = (v: readonly [number, number, number]): number[] => [v[0], v[1], v[2]];

interface ShotPlan {
  /** `cars` stands for every car area the GLB holds. */
  readonly areas: readonly (Area | "cars")[];
  readonly figure: boolean;
  readonly headlights: boolean;
  readonly tubes: boolean;
  readonly haze: { readonly density: number; readonly groups: readonly ("head" | "tube" | "back")[]; readonly ambient: readonly [number, number, number] };
  readonly dof: boolean;
  readonly echo: boolean;
  readonly mirror: boolean;
  readonly whiteRoom: boolean;
}

const PLANS: Record<Base, ShotPlan> = {
  tableau: { areas: ["wh", "cars"], figure: true, headlights: true, tubes: false, haze: { density: 0.035, groups: ["head"], ambient: [0.0025, 0.0045, 0.005] }, dof: true, echo: false, mirror: false, whiteRoom: false },
  title: { areas: ["wh", "cars", "title"], figure: false, headlights: true, tubes: false, haze: { density: 0.03, groups: ["head"], ambient: [0.006, 0.006, 0.0065] }, dof: true, echo: false, mirror: false, whiteRoom: false },
  quad: { areas: [], figure: true, headlights: false, tubes: false, haze: { density: 0.06, groups: ["back"], ambient: [0, 0, 0] }, dof: false, echo: false, mirror: true, whiteRoom: false },
  wheel: { areas: ["wh", "cars"], figure: false, headlights: true, tubes: false, haze: { density: 0.03, groups: ["head"], ambient: [0.004, 0.0042, 0.0045] }, dof: true, echo: false, mirror: false, whiteRoom: false },
  cyc: { areas: ["cyc"], figure: true, headlights: false, tubes: false, haze: { density: 0, groups: [], ambient: [0, 0, 0] }, dof: false, echo: true, mirror: false, whiteRoom: true },
};

/**
 * The figure's performance per shot, as expressions on the skin kernel's knobs. All angles
 * in radians about the rest axes (x = the figure's left, y = up, z = the way it faces);
 * a negative x swings a limb forward.
 */
function performance(shot: Base): Record<string, string | number[]> {
  // Arms from the export's A-pose down to the sides.
  const armsDown = { upperarmL: "z:-0.62", upperarmR: "z:0.62" };
  switch (shot) {
    case "tableau":
      // 0:16: back to the lens, arms thrown up in a wide V, pumping gently with the track.
      return {
        "upperarmL.z": "1.2 + sin(abstime * 2.2) * 0.06",
        "upperarmR.z": "-1.2 - sin(abstime * 2.2 + 0.4) * 0.06",
        "upperarmL.x": "-0.15",
        "upperarmR.x": "-0.15",
        "forearmL.z": "0.35",
        "forearmR.z": "-0.35",
        "handL.x": "-0.3",
        "handR.x": "-0.3",
        "chest.x": "-0.06",
        "neck.x": "-0.12 + sin(abstime * 2.2) * 0.04",
        "pelvis.y": "sin(abstime * 0.6) * 0.05",
        "thighL.z": "0.07",
        "thighR.z": "-0.07",
      };
    case "quad":
      // Profile, still, the head working with the beat, the near hand low.
      return {
        ...armsDown,
        "neck.x": "0.12 + sin(abstime * 4.2) * 0.07",
        "head.x": "sin(abstime * 4.2 + 0.4) * 0.05",
        "chest.x": "0.05 + sin(abstime * 2.1) * 0.02",
        "upperarmL.x": "-0.1",
        "forearmL.x": "-0.25",
        "upperarmR.x": "0.05",
        "forearmR.x": "-0.2",
      };
    case "cyc": {
      // A walk: 0.9 strides a second, legs opposite, arms opposite the legs, the pelvis bobbing.
      const phase = "(abstime * 5.655)";
      return {
        ...armsDown,
        "thighL.x": `-sin(${phase}) * 0.42`,
        "thighR.x": `sin(${phase}) * 0.42`,
        "shinL.x": `0.08 + 0.75 * max(cos(${phase}), 0) ^ 1.5`,
        "shinR.x": `0.08 + 0.75 * max(-cos(${phase}), 0) ^ 1.5`,
        "footL.x": `-0.15 * sin(${phase})`,
        "footR.x": `0.15 * sin(${phase})`,
        "upperarmL.x": `sin(${phase}) * 0.38`,
        "upperarmR.x": `-sin(${phase}) * 0.38`,
        "forearmL.x": "-0.35",
        "forearmR.x": "-0.35",
        "pelvis.y": `sin(${phase}) * 0.12`,
        "chest.y": `-sin(${phase}) * 0.1`,
        "neck.x": "0.06",
      };
    }
    default:
      return armsDown;
  }
}

export function onNothingDocument(facts: OnNothingFacts, options: OnNothingOptions): ProjectDocument {
  // The title and the ring build their own graphs (shots/), apart from the shots below.
  if (options.shot === "title") return titleDocument(facts, options);
  if (options.shot === "ring") return ringDocument(facts, options);
  const shot = options.shot;
  if (isCloseup(shot)) return closeupDocument(facts, { ...options, shot });
  // T1407b (split/mirror): composites of re-cut stock shots, built in shots/.
  if (shot === "split") return splitDocument(facts, onNothingDocument, options);
  if (shot === "mirror") return mirrorDocument(facts, onNothingDocument, options);
  // T1407b (lights): the light, detail and abstract rows, each a take on a stock shot (shots/lights.ts).
  if (shot === "lights") return lightsDocument(facts, options, onNothingDocument);
  if (shot === "incar") return incarDocument(facts, onNothingDocument, options); // T1407b (incar)
  // T1407b: the quad and the prism build their own graphs (shots/).
  if (shot === "quad") return quadDocument(facts, options);
  if (shot === "prism") return prismDocument(facts, options);
  // T1407b (halo, crt): built on the tableau's graph by shots/halo.ts and shots/crt.ts
  if (shot === "halo") return haloDocument(facts, options, onNothingDocument);
  if (shot === "crt") return crtDocument(facts, options, onNothingDocument);
  // T1407b (cyc): the white limbo's framings have their own builder (shots/cyc.ts).
  if (shot === "cyc" || shot === "cyc-wide") return cycDocument(facts, { shot, ...(options.width === undefined ? {} : { width: options.width }), ...(options.height === undefined ? {} : { height: options.height }), ...(options.crt === undefined ? {} : { crt: options.crt }) });
  const base = BASE_OF[shot];
  const plan = PLANS[base];
  /** The wheel shot's rigged car, moved to its own mark and creeping (shots/wheel.ts). */
  const rig = base === "wheel" ? wheelRig(facts) : undefined;
  const camera = facts.cameras.get(`shot.${base}`);
  if (camera === undefined) throw new Error(`onNothingDocument: the GLB has no camera "shot.${shot}".`);
  const eye = camera.eye;
  const aim: [number, number, number] = [eye[0] + camera.forward[0] * 6, eye[1] + camera.forward[1] * 6, eye[2] + camera.forward[2] * 6];
  const cameraRef = (field: string, fallback: number): StoredParameter => expressionSlot(`op('cam1').par.${field}`, fallback);
  const cameraParams: Record<string, StoredParameter> = {
    eye: vec(eye),
    aim,
    "eye.x": cameraRef("eye.x", eye[0]),
    "eye.y": cameraRef("eye.y", eye[1]),
    "eye.z": cameraRef("eye.z", eye[2]),
    "aim.x": cameraRef("lookAt.x", aim[0]),
    "aim.y": cameraRef("lookAt.y", aim[1]),
    "aim.z": cameraRef("lookAt.z", aim[2]),
    fov: cameraRef("fov", camera.fovDeg),
    far: cameraRef("far", 200),
    roll: cameraRef("roll", 0),
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const scenes: string[] = [];
  const lights: string[] = [];
  const projectors: string[] = [];

  // ── The song (render.ts --audio feeds the analysis): smoothed, normalised level lanes ──
  const audio = options.audio === true;
  if (audio) {
    nodes.push(node("song", "audioFileIn", [-4200, 1400], { file: "media/on-nothing/song.wav", playMode: "timeline" }, { label: "song1" }));
    nodes.push(node("pickLevels", "valueSelect", [-3900, 1300], { channels: "level low high" }, { label: "picklevels1" }));
    nodes.push(node("smooth", "valueLag", [-3600, 1300], { lag: 0.02, releaseRatio: 4 }, { label: "smooth1" }));
    nodes.push(node("rank", "valueNormalize", [-3300, 1300], { window: 16 }, { label: "rank1" }));
    // slow and smooth: the columns breathe with the track, they never twitch
    nodes.push(node("levels", "valueLag", [-3000, 1300], { lag: 1.0, releaseRatio: 1.5 }, { label: "levels1" }));
    edges.push(edge("song-pick", ["song", "out"], ["pickLevels", "in"]));
    edges.push(edge("pick-smooth", ["pickLevels", "out"], ["smooth", "in"]));
    edges.push(edge("smooth-rank", ["smooth", "out"], ["rank", "in"]));
    edges.push(edge("rank-levels", ["rank", "out"], ["levels", "in"]));
  }
  /** 0..1 loudness, smooth; 0.5 when silent (no --audio). */
  const LOUD = audio ? "clamp(op('levels1').chan.level * 0.6 + op('levels1').chan.low * 0.4, 0, 1)" : "0.5";
  // T1407b: the measured in-shot flicker of the glass and the lamps, and the kick lane's reach (shots/react.ts)
  const react = reactive(nodes, edges, REACT_PROFILES.tableau, audio ? "song" : undefined);

  // ── The material every surface wears ──
  // The title frames the grille from a metre: its own headlights would blow the frame out, so they idle.
  // every parked car darkens the floor under it (the driven car of the wheel shot moves: skip it)
  const footprints: Footprint[] = plan.areas.includes("cars")
    ? carAreas(facts).filter((area) => area !== rig?.area).map((area) => {
        const b = facts.areas.get(area)!.bounds;
        return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, (b.max[0] - b.min[0]) / 2 - 0.12, (b.max[2] - b.min[2]) / 2 - 0.25] as const;
      })
    : [];
  nodes.push(node("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: surfaceWgsl(footprints), headGain: base === "title" ? 0.04 : 1, wet: 0, wetGloss: 0.32, dryGloss: 0.6 }, { label: "surf1" }));

  // ── Meshes ──
  plan.areas.flatMap((entry) => (entry === "cars" ? carAreas(facts) : [entry])).forEach((area, index) => {
    const mesh = facts.areas.get(area);
    if (mesh === undefined) throw new Error(`onNothingDocument: no "${area}" area in the GLB.`);
    nodes.push(node(`mesh_${area}`, "meshFileIn", [-3600, index * 250], { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts }, { label: `mesh${area}1` }));
    nodes.push(node(`geo_${area}`, "geometry", [-3300, index * 250], { mode: "surface", material: "surf1" }, { label: `geo${area}1` }));
    if (rig !== undefined && area === rig.area) {
      // The rigged car drives; its wheels roll (car-rig.ts).
      nodes.push(node("carRig", "pointKernel", [-3450, index * 250], { capacity: mesh.vertices, attributes: CAR_RIG_ATTRIBUTES, kernel: carRigKernel(mesh.partTable), drive: expressionSlot(WHEEL_DRIVE, 0), place: [...rig.place], turn: WHEEL_TURN }, { label: "carrig1" }));
      edges.push(edge("mesh-rig-car", [`mesh_${area}`, "out"], ["carRig", "in"]));
      edges.push(edge("rig-geo-car", ["carRig", "out"], [`geo_${area}`, "points"]));
    } else {
      edges.push(edge(`mesh-geo-${area}`, [`mesh_${area}`, "out"], [`geo_${area}`, "points"]));
    }
    scenes.push(`geo${area}1`);
  });

  // ── Lamp glass: an ADDITIVE glint shell over every lamp (T1411b) ──
  // LAMP_GLASS_WGSL adds the covers' fresnel sheen and glints without covering anything, so the
  // lamp and its streak stay whole. Material · Glass (T1357b) is NOT used here: it samples the
  // scene ~thickness + 4 m behind the surface, which on a 1 cm cover reads the car's interior
  // instead of the lamp and put every headlight out (measured; see the T1400b row notes).
  const glassArea = facts.areas.get("lampglass");
  if (glassArea !== undefined && plan.areas.includes("cars")) {
    nodes.push(node("mesh_lampglass", "meshFileIn", [-3600, 900], { file: facts.glbUrl, select: glassArea.select, vertices: glassArea.vertices, triangles: glassArea.triangles, parts: glassArea.parts }, { label: "meshlampglass1" }));
    nodes.push(node("glassMat", "materialWgsl", [-3300, 950], { model: "unlit", source: LAMP_GLASS_WGSL, roughness: 0.02 }, { label: "glassmat1" }));
    nodes.push(node("geo_lampglint", "geometry", [-3000, 950], { mode: "surface", material: "glassmat1", blend: "additive" }, { label: "geolampglint1" }));
    edges.push(edge("mesh-geo-lampglint", ["mesh_lampglass", "out"], ["geo_lampglint", "points"]));
    scenes.push("geolampglint1");
  }

  // ── The figure, posed by the skin kernel ──
  if (plan.figure) {
    // the tableau set (0:16 and its zoom/prism) is shirtless; everywhere else the black tee
    const figArea = base === "tableau" ? "figbare" : "fig";
    const mesh = facts.areas.get(figArea);
    if (mesh === undefined) throw new Error("onNothingDocument: no figure in the GLB.");
    const stage = facts.stages.get(base);
    if (stage === undefined) throw new Error(`onNothingDocument: the GLB has no stage "stage.${base}".`);
    const pose: Record<string, StoredParameter> = {};
    const known = new Set(facts.bones.map(boneParam));
    for (const [key, value] of Object.entries(performance(base))) {
      if (typeof value === "string" && value.startsWith("z:")) {
        pose[key] = [0, 0, Number(value.slice(2))];
        continue;
      }
      const [bone, axis] = key.split(".");
      if (bone === undefined || !known.has(bone)) throw new Error(`performance(${shot}): no bone "${bone}".`);
      if (axis === undefined) throw new Error(`performance(${shot}): "${key}" names no axis.`);
      if (pose[bone] === undefined) pose[bone] = [0, 0, 0];
      pose[key] = expressionSlot(String(value), 0);
    }
    const walk = base === "cyc";
    const [px, py, pz] = stage.position;
    const [fx, , fz] = stage.facing;
    const place: Record<string, StoredParameter> = walk
      ? {
          place: [px, py, pz],
          // 1.25 m/s along the facing, from 2.5 m behind the mark; the pelvis bobs twice a stride.
          "place.x": expressionSlot(`${px} + ${fx} * (abstime * 1.25 - 2.5)`, px),
          "place.y": expressionSlot(`${py} - 0.025 + abs(cos(abstime * 5.655)) * 0.03`, py),
          "place.z": expressionSlot(`${pz} + ${fz} * (abstime * 1.25 - 2.5)`, pz),
        }
      : { place: [px, py, pz] };
    nodes.push(node("fig", "meshFileIn", [-3600, 1200], { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts, joints: mesh.joints }, { label: "fig1" }));
    nodes.push(node("skin", "pointKernel", [-3300, 1200], { capacity: mesh.vertices, attributes: SKIN_ATTRIBUTES, kernel: skinKernel(facts), yaw: yawFor(stage.facing), ...place, ...pose }, { label: "skin1" }));
    nodes.push(node("figGeo", "geometry", [-3000, 1200], { mode: "surface", material: "surf1" }, { label: "figgeo1" }));
    edges.push(edge("fig-skin", ["fig", "out"], ["skin", "in"]));
    edges.push(edge("skin-geo", ["skin", "out"], ["figGeo", "points"]));
    scenes.push("figgeo1");
  }

  // ── Light ──
  if (plan.headlights) {
    nodes.push(node("cookieSeed", "ramp", [-3000, 1600], {}, { label: "cookieseed1", resolution: { mode: "fixed", width: 256, height: 128 } }));
    nodes.push(node("cookie", "customWgsl", [-2800, 1600], { source: HEADLIGHT_COOKIE_WGSL }, { label: "cookie1", resolution: { mode: "fixed", width: 256, height: 128 } }));
    edges.push(edge("seed-cookie", ["cookieSeed", "out"], ["cookie", "input"]));
    // One projector per CAR, from between its headlights, throwing a two-lobed cookie: a
    // Render binds two textures per projector (cookie, occlusion) against a 16-texture stage.
    const heads = [...facts.markers.values()].filter((marker) => marker.name.startsWith("lamp.head."));
    const cars = [...new Set(heads.map((marker) => marker.name.slice("lamp.head.".length, -1)))].sort();
    cars.forEach((car, index) => {
      const pair = heads.filter((marker) => marker.name.slice("lamp.head.".length, -1) === car);
      const centre = [0, 1, 2].map((axis) => pair.reduce((sum, marker) => sum + marker.position[axis]!, 0) / pair.length) as [number, number, number];
      const dir = (pair[0]!.extras?.["loom_light_dir"] as number[] | undefined) ?? [0, 0, 1];
      const id = `head${index}`;
      nodes.push(node(id, "projector", [-2600, 1400 + index * 60], {
        eye: vec(centre),
        lookAt: [centre[0] + dir[0]! * 2, centre[1] + dir[1]! * 2, centre[2] + dir[2]! * 2],
        ...(rig !== undefined && car === rig.car ? riding(rig, "eye", centre) : {}),
        ...(rig !== undefined && car === rig.car ? riding(rig, "lookAt", [centre[0] + dir[0]! * 2, centre[1] + dir[1]! * 2, centre[2] + dir[2]! * 2]) : {}),
        throwRatio: 0.5,
        aspect: 2.4,
        brightness: react.lamp(2.5),
        // LED low beams read cool on concrete: a cyan-white, as the reference's floor shows.
        color: [0.78, 0.92, 1, 1],
        falloff: true,
        occlusion: true,
      }, { label: `${id}1` }));
      edges.push(edge(`cookie-${id}`, ["cookie", "out"], [id, "cookie"]));
      projectors.push(`${id}1`);
    });
  }
  /**
   * The room's practicals: old sodium high-bays. One high over the floor in front of the hero
   * car throws the warm pool the reference's floor carries (measured rgb 40,33,31 there against
   * a cyan-grey 24,26,25 beside it); two more, far and dim, warm the trusses.
   */
  function sodium(): void {
    const warm = [1, 0.52, 0.2, 1];
    nodes.push(node("sodiumPool", "light", [-2600, 2000], { kind: "point", position: [0.4, 2.6, 6.5], color: warm, intensity: 4, shadows: true, shadowExtent: 16, shadowSoftness: 2 }, { label: "sodiumpool1" }));
    nodes.push(node("sodiumA", "light", [-2600, 2100], { kind: "point", position: [-9, 7.2, -6], color: warm, intensity: 4 }, { label: "sodiuma1" }));
    nodes.push(node("sodiumB", "light", [-2600, 2200], { kind: "point", position: [10, 7.2, -9], color: warm, intensity: 3 }, { label: "sodiumb1" }));
    lights.push("sodiumpool1", "sodiuma1", "sodiumb1");
  }
  if (plan.tubes) {
    const tubes = [...facts.markers.values()].filter((marker) => marker.name.startsWith("lamp.tube.")).sort((a, b) => (a.name < b.name ? -1 : 1));
    tubes.forEach((marker, index) => {
      const id = `tube${index}`;
      nodes.push(node(id, "light", [-2600, 2200 + index * 60], { kind: "point", color: [0.9, 0.95, 1, 1], intensity: 1.6, position: vec(marker.position) }, { label: `${id}1` }));
      lights.push(`${id}1`);
    });
  }
  if (base === "tableau") {
    // A dim, soft front key from high camera-left, so the face and the chain read at all.
    // A point, not a sun: it falls off before the foreground floor, so the floor stays dark.
    const stage = facts.stages.get("tableau")!.position;
    nodes.push(node("fill", "light", [-2600, 1000], { kind: "point", position: [stage[0] - 1.1, 2.1, stage[2] + 1.5], color: [0.88, 0.92, 1, 1], intensity: 5 }, { label: "fill1" }));
    // The room's own light: a soft top, so the white bodies and the roof read at a few percent.
    nodes.push(node("top", "light", [-2600, 900], { kind: "directional", direction: [0.1, -1, 0.15], color: [0.9, 0.93, 1, 1], intensity: 0.12 }, { label: "top1" }));
    // The cars' own key: a broad soft source behind the camera, high — the reference's white
    // bodies read clearly, grille chrome and all, while the room stays black.
    // LOW, beside the camera (out of frame): in the reference only the cars' lower fronts catch light (bumpers, grilles,
    // lamps) and their roofs fall into black. A point low in front of the row, falling off with
    // height and distance, does that; a sun lit them top to bottom and made them read huge.
    // it CASTS: the cars throw their shadows back onto the floor under and behind them
    nodes.push(node("carKey", "light", [-2600, 800], { kind: "point", position: [0, 0.45, 13.5], color: [0.88, 0.94, 1, 1], intensity: 22, shadows: true, shadowExtent: 30, shadowSoftness: 2 }, { label: "carkey1" }));
    // no top light: the reference's roofs fall into black
    lights.push("fill1", "carkey1");
    sodium();
  }
  if (rig !== undefined) {
    wheelLights(rig).forEach((light, index) => {
      nodes.push(node(`wheelLight${index}`, "light", [-2600, 2000 + index * 100], light, { label: `wheellight${index}1` }));
      lights.push(`wheellight${index}1`);
    });
  } else if (base === "wheel") {
    // no rigged car in this GLB: the interim raking key (the rig's own lights are shots/wheel.ts)
    sodium();
    // a low raking key along the car's flank: the wheel's spokes and the door read, as in 2:00
    nodes.push(node("wheelKey", "light", [-2600, 700], { kind: "point", position: [eye[0] + 2.5, 0.6, eye[2] + 1.0], color: [0.9, 0.95, 1, 1], intensity: 14 }, { label: "wheelkey1" }));
    lights.push("wheelkey1");
  }
  if (base === "title") {
    sodium();
    // A soft top over the bonnet: the chrome script and the grille bars catch it; the room stays dim.
    nodes.push(node("fill", "light", [-2600, 1000], { kind: "point", position: [0, 2.6, 0.9], color: [1, 0.97, 0.92, 1], intensity: 5 }, { label: "fill1" }));
    nodes.push(node("top", "light", [-2600, 900], { kind: "directional", direction: [0.1, -1, 0.3], color: [1, 0.93, 0.85, 1], intensity: 0.12 }, { label: "top1" }));
    lights.push("fill1", "top1");
  }
  if (base === "quad") {
    const back = markerOf(facts, "lamp.back.quad");
    nodes.push(node("back", "light", [-2600, 1000], { kind: "point", color: [0.3, 0.8, 0.85, 1], intensity: 9, position: vec(back.position) }, { label: "back1" }));
    // Two rims just behind the figure, either side, grazing its edges: the thin bright outline.
    const stage = facts.stages.get("quad")!.position;
    nodes.push(node("rimA", "light", [-2600, 1100], { kind: "point", color: [0.75, 0.95, 1, 1], intensity: 1.6, position: [stage[0] - 0.55, 1.55, stage[2] - 0.7] }, { label: "rima1" }));
    nodes.push(node("rimB", "light", [-2600, 1200], { kind: "point", color: [0.75, 0.95, 1, 1], intensity: 1.6, position: [stage[0] + 0.55, 1.55, stage[2] - 0.7] }, { label: "rimb1" }));
    lights.push("back1", "rima1", "rimb1");
  }
  if (base === "cyc") {
    const key = markerOf(facts, "lamp.key.cyc");
    const dir = (key.extras?.["loom_light_dir"] as number[] | undefined) ?? [-0.4, -0.7, -0.6];
    nodes.push(node("key", "light", [-2600, 1000], { kind: "directional", direction: [dir[0]!, dir[1]!, dir[2]!], color: [1, 0.99, 0.97, 1], intensity: 3.2, shadows: true, shadowExtent: 9, shadowSoftness: 1 }, { label: "key1" }));
    lights.push("key1");
  }

  // ── Environment (reflections) ──
  nodes.push(node("envSeed", "ramp", [-2700, 300], {}, { label: "envseed1", resolution: { mode: "fixed", width: 1024, height: 512 } }));
  nodes.push(node("env", "customWgsl", [-2700, 500], { source: ENVIRONMENT_WGSL, white: plan.whiteRoom ? 1 : 0, bars: base === "title" ? 6 : base === "quad" ? 0 : 1.5, roof: base === "title" ? 0.35 : base === "quad" ? 0 : 0.006 }, { label: "env1", resolution: { mode: "fixed", width: 1024, height: 512 } }));
  edges.push(edge("seed-env", ["envSeed", "out"], ["env", "input"]));
  if (options.hdri === true && !plan.whiteRoom) {
    nodes.push(node("hdri", "movieFileIn", [-2900, 700], { file: "media/on-nothing/hdri.png" }, { label: "hdri1", resolution: { mode: "fixed", width: 2048, height: 1024 } }));
    nodes.push(node("envHdri", "customWgsl", [-2700, 700], { source: ENVIRONMENT_HDRI_WGSL, gain: base === "title" ? 1.2 : 0.6, crush: base === "title" ? 0.3 : 0.7 }, { label: "envhdri1", resolution: { mode: "fixed", width: 2048, height: 1024 } }));
    edges.push(edge("hdri-env", ["hdri", "out"], ["envHdri", "input"]));
  }

  // ── Camera and the Render ──
  // zoom (0:24): the wide tableau, then a violent crash-zoom onto the face at 1.4 s.
  const face = (() => {
    const stage = facts.stages.get("tableau");
    return stage === undefined ? aim : ([stage.position[0], 1.6, stage.position[2]] as [number, number, number]);
  })();
  const SNAP = "(clamp((abstime - 1.4) / 0.16, 0, 1) ^ 2 * (3 - 2 * clamp((abstime - 1.4) / 0.16, 0, 1)))";
  /** The tableau's operator; the zoom CONTINUES it (its clock picks up where the tableau's 5 s ended). */
  const TABLEAU_HANDHELD = { tiltIn: -2.6, tilt: -0.9, settle: 1.5, shake: 1, creep: 0.12 } as const;
  const TABLEAU_SECONDS = 5;
  const wideFov = camera.fovDeg;
  /**
   * zoom (0:24): the tableau's camera carrying on (same operator, same tilt, same creep), then a
   * violent crash-zoom at 1.4 s onto the raised-arms back — the lens racks from the wide to 7.5°
   * and the aim lands on the upper back; the handheld keeps working through and after the snap.
   */
  function zoomMove(): Record<string, StoredParameter> {
    const hh = handheld(eye, aim, { ...TABLEAU_HANDHELD, timeOffset: TABLEAU_SECONDS });
    const src = (key: string): string => (hh[key] as unknown as { bindings: { expression: { source: string } } }).bindings.expression.source;
    const back: [number, number, number] = [face[0], 1.42, face[2]];
    const blend = (key: string, target: number): StoredParameter => expressionSlot(`(${src(key)}) * (1 - ${SNAP}) + (${target} + (${src(key)}) - ${key.startsWith("lookAt.x") ? aim[0] : key.startsWith("lookAt.y") ? aim[1] : aim[2]}) * ${SNAP}`, target);
    return {
      "eye.x": hh["eye.x"]!,
      "eye.y": hh["eye.y"]!,
      "eye.z": hh["eye.z"]!,
      roll: hh["roll"]!,
      fov: expressionSlot(`${wideFov.toFixed(3)} + (7.5 - ${wideFov.toFixed(3)}) * ${SNAP}`, wideFov),
      "lookAt.x": blend("lookAt.x", back[0]),
      "lookAt.y": blend("lookAt.y", back[1]),
      "lookAt.z": blend("lookAt.z", back[2]),
    };
  }

  const cameraMove: Record<string, StoredParameter> =
    shot === "zoom"
      ? zoomMove()
        : rig !== undefined
          ? wheelCamera(rig)
          : shot === "tableau"
            ? handheld(eye, aim, TABLEAU_HANDHELD)
            : base === "wheel"
              // no rigged car in this GLB (the wheel rig lands with the wheel shot's own work):
              // at least the operator tracks along the parked car instead of a dead frame
              ? handheld(eye, aim, { tiltIn: 4, tilt: 2, settle: 1, shake: 1.3, creep: 0 })
              : {};
  nodes.push(node("cam", "camera", [-2700, -900], { eye: vec(eye), lookAt: aim, fov: camera.fovDeg, near: 0.05, far: 200, ...cameraMove }, { label: "cam1" }));
  nodes.push(node("shot", "render", [-2400, 0], {
    scenes: scenes.join(" "),
    camera: "cam1",
    lights: lights.join(" "),
    projectors: projectors.join(" "),
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: plan.whiteRoom ? 0.55 : 0.0,
    background: plan.whiteRoom ? [0.9, 0.9, 0.9, 1] : [0, 0, 0, 1],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    albedoOutput: true,
    environmentIntensity: plan.whiteRoom ? 0.6 : base === "title" ? 1 : base === "quad" ? 0 : 0.1,
    environmentTaps: 16,
  }, { label: "shot1" }));
  edges.push(edge("env-shot", [options.hdri === true && !plan.whiteRoom ? "envHdri" : "env", "out"], ["shot", "environment"]));

  // ── Screen space: reflections, contact occlusion, haze ──
  let last: readonly [string, string] = ["shot", "out"];
  const pass = (id: string, source: string, extra: Record<string, StoredParameter>, more: readonly (readonly [string, string])[], position: readonly [number, number], scale = 1): void => {
    nodes.push(node(id, more.length > 0 ? "customWgslMulti" : "customWgsl", position, { source, ...extra }, { label: `${id.toLowerCase()}1`, resolution: scale === 1 ? { mode: "project" } : { mode: "scale", factor: scale } }));
    edges.push(edge(`${last[0]}-${id}`, last, [id, "input"]));
    more.forEach((port, index) => edges.push(edge(`${id}-more${index}`, port, [id, "more"], index)));
    last = [id, "out"];
  };
  const depth = ["shot", "depth"] as const;
  const normal = ["shot", "normal"] as const;
  pass("reflections", GLOSSY_SSR_WGSL, { ...cameraParams, strength: 1.2, maxDistance: 30, roughnessCutoff: 0.55, thickness: 0.4, blur: 1.6, stretch: 4, keepBright: 4, dimShare: 0.1, ...(base === "wheel" ? WHEEL_SSR : {}) }, [depth, normal], [-2100, 0]);
  pass("occlusion", GTAO_WGSL, { ...cameraParams, radius: plan.whiteRoom ? 0.5 : 1.3, strength: plan.whiteRoom ? 0.6 : 0.95, power: 1.6 }, [depth, normal], [-1900, 0]);
  if (plan.haze.density > 0) {
    const haze = hazeLights(facts, plan.haze.groups);
    pass("haze", hazeWgsl(rig === undefined ? haze : placedHaze(facts, rig, haze)), { ...cameraParams, density: plan.haze.density, ambient: vec(plan.haze.ambient), anisotropy: 0.72, head: base === "title" ? 0.01 : react.lamp(0.25) }, [depth], [-1700, 0]);
  }
  if (plan.dof) {
    // focus: the title's script at 1.3 m; the tableau's figure (the rear row falls soft)
    const focus = base === "title" ? 1.3 : base === "tableau" ? 11.0 : 0;
    pass("lens_dof", DOF_WGSL, { ...cameraParams, ...(base === "wheel" ? WHEEL_DOF : { aperture: base === "title" ? 0.5 : 0.45, maxRadius: 16, focusDistance: focus }) }, [depth], [-1500, 0]);
  }
  if (base === "wheel") {
    // Outlined letters on the beat, into the HDR picture so the streak glass smears them (shots/wheel.ts).
    pass("glyphs", WHEEL_GLYPHS_WGSL, WHEEL_GLYPHS, [], [-1450, 0]);
  }
  const scene = last;
  const opticsGain: Record<Base, { streak: number; halo: number }> = {
    tableau: { streak: 0.8, halo: 0 },
    wheel: { streak: 0.55, halo: 0 },
    title: { streak: 0.35, halo: 0.15 },
    quad: { streak: 0.25, halo: 0 },
    cyc: { streak: 0.1, halo: 0 },
  };
  /** How far each shot's streak slabs reach above their source, as a fraction of the frame height. */
  const streakReach: Record<Base, number> = { wheel: 0.3, tableau: 0.36, title: 0.4, quad: 0.45, cyc: 0.2 };

  // ── Optics: streak columns (half size), halo rings (quarter), bloom pyramid ──
  // A "scale" resolution is relative to the node's own INPUT, so each chained pass states its
  // factor against the pass before it: the bloom halves on the way down and doubles back up.
  nodes.push(node("bright", "customWgsl", [-1300, 300], { source: BRIGHT_PASS_WGSL, threshold: plan.whiteRoom ? 3 : 1.4, knee: 0.8 }, { label: "bright1", resolution: { mode: "scale", factor: 0.5 } }));
  // The streaks' OWN source, far above the bloom's: only clipped lamps streak in the reference —
  // never chrome glints, lit paint or a sodium pool (the owner: "over the top… sensitivity").
  nodes.push(node("streakSrc", "customWgsl", [-1300, 200], { source: BRIGHT_PASS_WGSL, threshold: plan.whiteRoom ? 6 : 4.5, knee: 1.2 }, { label: "streaksrc1", resolution: { mode: "scale", factor: 0.5 } }));
  edges.push(edge("scene-streaksrc", scene, ["streakSrc", "input"]));
  edges.push(edge("scene-bright", scene, ["bright", "input"]));
  // The streak glass copies each bright SHAPE straight up: a flat-sided slab exactly the width
  // of the lamp that holds its brightness and ends softly at the reach — three chained box
  // passes (each step under the span of the pass before) fed by the SHARP bright pass, so each
  // LED element in a lamp draws its own line inside the column, as in the reference.
  const reach = streakReach[base];
  // Every column EXTENDS and RETRACTS together with the song, smoothly: the reach is a lane.
  // ONE direction per cut: the columns grow steadily through the shot, and the song only
  // leans on that very slowly (a 1 s lag) — never a jitter.
  const reachExpr = `(${reach} * (0.62 + 0.3 * clamp(abstime / 4, 0, 1) + 0.18 * ${LOUD}))`;
  // 16 taps a pass: each pass's span (16 steps) covers the next pass's step twice over, so the
  // three convolve into one smooth column — no stepped tops, no banded copies of each LED.
  const STREAKS = [reach / 400, reach / 60, reach / 20] as const;
  const STREAK_DIV = [400, 60, 20] as const;
  STREAKS.forEach((step, index) => {
    const id = `streak${index}`;
    nodes.push(node(id, "customWgsl", [-1100 + index * 100, 300], { source: STREAK_WGSL, step: expressionSlot(`${reachExpr} / ${STREAK_DIV[index]}`, step), decay: index === 2 ? 1.6 : 50, finish: index === 2 ? 1 : 0, spread: index === 0 ? 0.003 : 0, compress: index === 0 ? 3 : 0, ...(index === 0 ? { minSize: 0.006 } : {}), down: 0, gain: 1.8, striation: 0.22, striationScale: 110 }, { label: `${id}1`, resolution: { mode: "scale", factor: 1 } }));
    edges.push(edge(`into-${id}`, [index === 0 ? "streakSrc" : `streak${index - 1}`, "out"], [id, "input"]));
  });
  nodes.push(node("hot", "customWgsl", [-1300, 500], { source: BRIGHT_PASS_WGSL, threshold: 150, knee: 30 }, { label: "hot1", resolution: { mode: "scale", factor: 0.25 } }));
  edges.push(edge("scene-hot", scene, ["hot", "input"]));
  nodes.push(node("halo", "customWgsl", [-1100, 500], { source: HALO_WGSL, radius: 0.3, width: 0.006, dispersion: 0.14, axis: 0.08 }, { label: "halo1", resolution: { mode: "scale", factor: 1 } }));
  edges.push(edge("hot-halo", ["hot", "out"], ["halo", "input"]));
  for (const level of [1, 2, 3, 4]) {
    nodes.push(node(`bloomDown${level}`, "customWgsl", [-900, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, { label: `bloomdown${level}1`, resolution: { mode: "scale", factor: 0.5 } }));
    edges.push(edge(`bloom-down${level}`, [level === 1 ? "bright" : `bloomDown${level - 1}`, "out"], [`bloomDown${level}`, "input"]));
  }
  for (const level of [0, 1, 2, 3]) {
    nodes.push(node(`bloomUp${level}`, "customWgslMulti", [-700, 150 + level * 150], { source: BLOOM_UP_WGSL, lower: 1 }, { label: `bloomup${level}1`, resolution: { mode: "scale", factor: 2 } }));
    edges.push(edge(`bloom-up${level}-lower`, [level === 3 ? "bloomDown4" : `bloomUp${level + 1}`, "out"], [`bloomUp${level}`, "input"]));
    edges.push(edge(`bloom-up${level}-own`, [level === 0 ? "bright" : `bloomDown${level}`, "out"], [`bloomUp${level}`, "more"], 0));
  }
  pass("optics", OPTICS_COMPOSITE_WGSL, { streak: opticsGain[base].streak, halo: opticsGain[base].halo, bloom: 0.12, streakTint: [0.9, 0.97, 1, 1] }, [react.streak(["streak2", "out"]), ["halo", "out"], ["bloomUp0", "out"]], [-500, 0]);

  // ── Lens and grade ──
  const snapBlur: Record<string, StoredParameter> =
    shot === "zoom" ? { zoomBlur: expressionSlot("0.22 * max(1 - abs(abstime - 1.5) / 0.12, 0) ^ 2", 0) }
    : {};
  pass("lens", LENS_WGSL, plan.whiteRoom ? { distortion: 0.03, edgeBlur: 0.012, vignette: 0.8, vignetteRound: 0.9 } : { distortion: 0.06, edgeBlur: 0.014, vignette: 0.6, ...snapBlur }, [], [-300, 0]);
  const grade: Record<Base, Record<string, StoredParameter>> = {
    wheel: WHEEL_GRADE,
    // Not black and white: sodium warmth in the floor pool, cyan in the LED spill and the haze,
    // cyan-green in the greys — measured from the reference (docs plan, 'colour').
    tableau: { exposure: 0.2, black: 0.035, contrast: 1.18, saturation: 0.62, keepWarm: 0.9, steel: [0.96, 1.01, 1.03], shadowTint: [0.96, 1.02, 1.03, 1], split: 0.4 },
    title: { exposure: 0.4, black: 0.03, contrast: 1.15, saturation: 0.6, keepWarm: 0.9, steel: [0.97, 1.0, 1.02], shadowTint: [0.97, 1.01, 1.02, 1], split: 0.35 },
    quad: { exposure: 0.1, black: 0.05, contrast: 1.25, saturation: 0.75, keepWarm: 0.75, steel: [0.9, 1.02, 1.04], shadowTint: [0.9, 1.03, 1.06, 1] },
    cyc: { exposure: 0.9, black: 0.02, contrast: 1.1, saturation: 0.15, steel: [0.97, 1, 1.02], shadowTint: [1, 1, 1, 1], lift: 0.02, grain: 0.02 },
  };
  pass("grade", GRADE_WGSL, grade[base], [], [-100, 0]);
  if (plan.echo) {
    nodes.push(node("echoHistory", "feedback", [100, 300], { source: "echo1" }, { label: "echohistory1" }));
    pass("echo", ECHO_WGSL, { amount: 0.55, darken: 1 }, [["echoHistory", "out"]], [100, 0]);
  }
  if (plan.mirror) {
    pass("mirror", MIRROR_WGSL, { tiles: 4, crop: 0.3, centre: 0.527, flip: 1, phase: 1 }, [], [300, 0]);
  }
  if (options.crt === true) {
    pass("crt", CRT_WGSL, { amount: 1 }, [], [500, 0]);
  }
  nodes.push(node("out", "output", [700, 0], { toneMap: "none" }, { label: "out1" }));
  edges.push(edge("last-out", last, ["out", "input"]));

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: `project-on-nothing-${shot}`,
    name: `On Nothing · ${shot}`,
    graph: graph(nodes, edges),
    settings: settings({
      outputResolution: { width: options.width ?? 1920, height: options.height ?? 818 },
      randomSeed: 7,
      limits: { ...LIMITS, memoryBudgetBytes: 3_221_225_472 },
    }),
    assets: [],
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
}
