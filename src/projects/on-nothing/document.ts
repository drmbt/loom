import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../furnace/post.ts";
import { DOF_WGSL, GTAO_WGSL } from "../furnace/screen-space.ts";
import { GLOSSY_SSR_WGSL } from "./reflections.ts";
import { ENVIRONMENT_HDRI_WGSL, ENVIRONMENT_WGSL, HEADLIGHT_COOKIE_WGSL, hazeLights, hazeWgsl } from "./atmosphere.ts";
import { CRT_WGSL, ECHO_WGSL, GRADE_WGSL, HALO_WGSL, LENS_WGSL, MIRROR_WGSL, OPTICS_COMPOSITE_WGSL, PRISM_WGSL, STREAK_WGSL } from "./fx.ts";
import type { Area, OnNothingFacts } from "./scene-facts.ts";
import { markerOf } from "./scene-facts.ts";
import { SKIN_ATTRIBUTES, boneParam, skinKernel, yawFor } from "./skin-kernel.ts";
import { SURFACE_WGSL } from "./surface.ts";
import { CAR_RIG_ATTRIBUTES, carRigKernel, drivenCar } from "./car-rig.ts";
import { GLYPHS_WGSL } from "./tracking.ts";

/** The wheel shot: how far the rigged car has driven, metres (a slow roll past the others). */
const DRIVE = "(abstime * 2.2)";

/**
 * T1400b — THE ON NOTHING DOCUMENTS: one graph per shot, built from the GLB's measured facts.
 *
 * Every shot runs the same chain — Render (G-buffer) → reflections → contact occlusion →
 * haze → [depth of field] → the optics (streak columns, halo rings, bloom) → lens → grade →
 * [echo] → [mirror tiles] → [CRT] → Output — and differs in what it draws, how it is lit,
 * what the figure does and which finishing layers run. See
 * docs/on-nothing-shots-plan-2026-09-27.md for what each shot is after.
 */

export const SHOTS = ["tableau", "title", "quad", "cyc", "zoom", "prism", "wheel"] as const;
export type Shot = (typeof SHOTS)[number];
/** The four sets; `zoom` and `prism` are the tableau's set with their own camera and finish. */
type Base = "tableau" | "title" | "quad" | "cyc" | "wheel";
const BASE_OF: Record<Shot, Base> = { tableau: "tableau", title: "title", quad: "quad", cyc: "cyc", zoom: "tableau", prism: "tableau", wheel: "wheel" };

export interface OnNothingOptions {
  readonly shot: Shot;
  readonly width?: number;
  readonly height?: number;
  /** Run the CRT re-scan over the finished frame. */
  readonly crt?: boolean;
  /** Light reflections from a real HDRI (a Movie File In `hdri`, fed RGBM; see hdri.ts). */
  readonly hdri?: boolean;
}

function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const vec = (v: readonly [number, number, number]): number[] => [v[0], v[1], v[2]];

interface ShotPlan {
  readonly areas: readonly Area[];
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
  tableau: { areas: ["wh", "car"], figure: true, headlights: true, tubes: false, haze: { density: 0.035, groups: ["head"], ambient: [0.004, 0.0042, 0.0045] }, dof: false, echo: false, mirror: false, whiteRoom: false },
  title: { areas: ["wh", "car", "title"], figure: false, headlights: true, tubes: false, haze: { density: 0.03, groups: ["head"], ambient: [0.006, 0.006, 0.0065] }, dof: true, echo: false, mirror: false, whiteRoom: false },
  quad: { areas: [], figure: true, headlights: false, tubes: false, haze: { density: 0.06, groups: ["back"], ambient: [0, 0, 0] }, dof: false, echo: false, mirror: true, whiteRoom: false },
  wheel: { areas: ["wh", "car"], figure: false, headlights: true, tubes: false, haze: { density: 0.03, groups: ["head"], ambient: [0.004, 0.0042, 0.0045] }, dof: false, echo: false, mirror: false, whiteRoom: false },
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
      // Weight on one hip, a slow sway; the right arm comes up in a loose gesture and drops.
      return {
        ...armsDown,
        "pelvis.y": "sin(abstime * 0.7) * 0.12",
        "pelvis.z": "0.04 + sin(abstime * 0.7) * 0.02",
        "chest.z": "-0.05 + sin(abstime * 1.4) * 0.03",
        "neck.x": "0.08 + sin(abstime * 2.2) * 0.06",
        "head.y": "sin(abstime * 0.5) * 0.15",
        "upperarmR.x": "-0.9 - 0.35 * (0.5 + 0.5 * sin(abstime * 1.3))",
        "upperarmR.z": "0.35",
        "forearmR.x": "-1.1 - 0.3 * sin(abstime * 2.6)",
        "upperarmL.x": "-0.2 + sin(abstime * 0.9) * 0.1",
        "forearmL.x": "-0.35",
        "thighL.z": "0.06",
        "thighR.z": "-0.1",
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
  const shot = options.shot;
  const base = BASE_OF[shot];
  const plan = PLANS[base];
  /** The wheel shot's car drives `DRIVE` metres; what rides with it follows by this helper. */
  const carParts = facts.areas.get("car")?.partTable ?? [];
  const driven = base === "wheel" && carParts.length > 0 ? (() => {
    const car = drivenCar(carParts);
    return { car: car.body.name.slice(3), forward: car.forward, right: car.right, pivot: car.body.pivot };
  })() : undefined;
  const follow = (key: string, at: readonly [number, number, number], forward: readonly [number, number, number]): Record<string, StoredParameter> => ({
    [`${key}.x`]: expressionSlot(`${at[0]} + ${forward[0].toFixed(5)} * ${DRIVE}`, at[0]),
    [`${key}.y`]: expressionSlot(`${at[1]} + ${forward[1].toFixed(5)} * ${DRIVE}`, at[1]),
    [`${key}.z`]: expressionSlot(`${at[2]} + ${forward[2].toFixed(5)} * ${DRIVE}`, at[2]),
  });
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

  // ── The material every surface wears ──
  // The title frames the grille from a metre: its own headlights would blow the frame out, so they idle.
  nodes.push(node("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: SURFACE_WGSL, headGain: base === "title" ? 0.04 : 1, wet: base === "title" ? 0.2 : 0.4 }, { label: "surf1" }));

  // ── Meshes ──
  plan.areas.forEach((area, index) => {
    const mesh = facts.areas.get(area);
    if (mesh === undefined) throw new Error(`onNothingDocument: no "${area}" area in the GLB.`);
    nodes.push(node(`mesh_${area}`, "meshFileIn", [-3600, index * 250], { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts }, { label: `mesh${area}1` }));
    nodes.push(node(`geo_${area}`, "geometry", [-3300, index * 250], { mode: "surface", material: "surf1" }, { label: `geo${area}1` }));
    if (base === "wheel" && area === "car") {
      // The rigged car drives; its wheels roll (car-rig.ts).
      nodes.push(node("carRig", "pointKernel", [-3450, index * 250], { capacity: mesh.vertices, attributes: CAR_RIG_ATTRIBUTES, kernel: carRigKernel(mesh.partTable), drive: expressionSlot(DRIVE, 0) }, { label: "carrig1" }));
      edges.push(edge("mesh-rig-car", [`mesh_${area}`, "out"], ["carRig", "in"]));
      edges.push(edge("rig-geo-car", ["carRig", "out"], [`geo_${area}`, "points"]));
    } else {
      edges.push(edge(`mesh-geo-${area}`, [`mesh_${area}`, "out"], [`geo_${area}`, "points"]));
    }
    scenes.push(`geo${area}1`);
  });

  // ── The figure, posed by the skin kernel ──
  if (plan.figure) {
    const mesh = facts.areas.get("fig");
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
        ...(base === "wheel" && driven !== undefined && car === driven.car ? follow("eye", centre, driven.forward) : {}),
        ...(base === "wheel" && driven !== undefined && car === driven.car ? follow("lookAt", [centre[0] + dir[0]! * 2, centre[1] + dir[1]! * 2, centre[2] + dir[2]! * 2], driven.forward) : {}),
        throwRatio: 0.5,
        aspect: 2.4,
        brightness: 2.5,
        color: [0.92, 0.95, 1, 1],
        falloff: true,
        occlusion: true,
      }, { label: `${id}1` }));
      edges.push(edge(`cookie-${id}`, ["cookie", "out"], [id, "cookie"]));
      projectors.push(`${id}1`);
    });
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
    lights.push("fill1", "top1");
  }
  if (base === "title") {
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
  // prism (0:29): the face, close, through the prism.
  const face = (() => {
    const stage = facts.stages.get("tableau");
    return stage === undefined ? aim : ([stage.position[0], 1.6, stage.position[2]] as [number, number, number]);
  })();
  const SNAP = "(clamp((abstime - 1.4) / 0.16, 0, 1) ^ 2 * (3 - 2 * clamp((abstime - 1.4) / 0.16, 0, 1)))";
  /**
   * The title (0:00): the camera WHIPS in from the right (a fast pan, smeared by the lens's
   * whip blur, settling by 0.35 s), then pivots slowly round the script while it pushes in —
   * an arc about the grille, never a straight dolly — with a breath of handheld.
   */
  const WHIP = "clamp(1 - abstime / 0.35, 0, 1) ^ 2";
  function titleMove(): Record<string, StoredParameter> {
    const centre: [number, number, number] = [0, 0.74, 0.13];
    const dx = eye[0] - centre[0];
    const dz = eye[2] - centre[2];
    const radius = Math.hypot(dx, dz);
    const start = Math.atan2(dx, dz);
    const angle = `(${start.toFixed(4)} - 0.16 + abstime * 0.07)`;
    const r = `(${radius.toFixed(4)} * (1 - abstime * 0.025))`;
    return {
      "eye.x": expressionSlot(`${centre[0]} + ${r} * sin(${angle}) + sin(abstime * 1.7) * 0.004`, eye[0]),
      "eye.y": expressionSlot(`${eye[1]} + abstime * 0.012 + sin(abstime * 2.3 + 1) * 0.003`, eye[1]),
      "eye.z": expressionSlot(`${centre[2]} + ${r} * cos(${angle})`, eye[2]),
      "lookAt.x": expressionSlot(`${centre[0]} + ${WHIP} * 2.2 + sin(abstime * 1.1) * 0.006`, centre[0]),
      "lookAt.y": expressionSlot(`${centre[1]}`, centre[1]),
      "lookAt.z": expressionSlot(`${centre[2]}`, centre[2]),
      fov: 52,
    };
  }
  const cameraMove: Record<string, StoredParameter> =
    shot === "zoom"
      ? {
          fov: expressionSlot(`${camera.fovDeg.toFixed(3)} + (7.5 - ${camera.fovDeg.toFixed(3)}) * ${SNAP}`, camera.fovDeg),
          "lookAt.x": expressionSlot(`${aim[0]} + (${face[0]} - ${aim[0]}) * ${SNAP} + sin(abstime * 7.3) * 0.006 * ${SNAP}`, aim[0]),
          "lookAt.y": expressionSlot(`${aim[1]} + (${face[1]} - ${aim[1]}) * ${SNAP} + sin(abstime * 5.1 + 1) * 0.005 * ${SNAP}`, aim[1]),
          "lookAt.z": expressionSlot(`${aim[2]} + (${face[2]} - ${aim[2]}) * ${SNAP}`, aim[2]),
        }
      : shot === "title"
        ? titleMove()
        : shot === "prism"
        ? { fov: 9, lookAt: vec(face), "lookAt.x": expressionSlot(`${face[0]} + sin(abstime * 0.6) * 0.01`, face[0]), "lookAt.y": expressionSlot(`${face[1]} + sin(abstime * 0.9) * 0.006`, face[1]) }
        : base === "wheel" && driven !== undefined
          ? { ...follow("eye", eye, driven.forward), ...follow("lookAt", aim, driven.forward) }
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
    environmentIntensity: plan.whiteRoom ? 0.6 : base === "title" ? 1 : base === "quad" ? 0 : 0.4,
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
  pass("reflections", GLOSSY_SSR_WGSL, { ...cameraParams, strength: 1, maxDistance: 30, roughnessCutoff: 0.5, thickness: 0.4 }, [depth, normal], [-2100, 0]);
  pass("occlusion", GTAO_WGSL, { ...cameraParams, radius: 0.5, strength: plan.whiteRoom ? 0.6 : 0.8 }, [depth, normal], [-1900, 0]);
  if (plan.haze.density > 0) {
    pass("haze", hazeWgsl(hazeLights(facts, plan.haze.groups)), { ...cameraParams, density: plan.haze.density, ambient: vec(plan.haze.ambient), anisotropy: 0.72, head: base === "title" ? 0.01 : 0.25 }, [depth], [-1700, 0]);
  }
  if (plan.dof) {
    pass("lens_dof", DOF_WGSL, { ...cameraParams, aperture: 0.5, maxRadius: 16, focusDistance: 1.3 }, [depth], [-1500, 0]);
  }
  const scene = last;
  const opticsGain: Record<Base, { streak: number; halo: number }> = {
    tableau: { streak: 0.5, halo: 0.12 },
    wheel: { streak: 0.5, halo: 0 },
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
  edges.push(edge("scene-bright", scene, ["bright", "input"]));
  // The streak glass copies each bright SHAPE straight up: a flat-sided slab the width of the
  // source that holds its brightness and ends softly at the reach — three chained box passes
  // (each step under the span of the pass before) fed by the bloom's first level, so the slab
  // carries the lamp's clipped glare, not only its lens.
  const reach = streakReach[base];
  const STREAKS = [reach / 160, reach / 48, reach / 10] as const;
  STREAKS.forEach((step, index) => {
    const id = `streak${index}`;
    nodes.push(node(id, "customWgsl", [-1100 + index * 100, 300], { source: STREAK_WGSL, step, decay: index === 2 ? 1.2 : 50, finish: index === 2 ? 1 : 0, spread: index === 0 ? 0.004 : 0 }, { label: `${id}1`, resolution: { mode: "scale", factor: 1 } }));
    edges.push(edge(`into-${id}`, [index === 0 ? "bloomUp0" : `streak${index - 1}`, "out"], [id, "input"]));
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
  pass("optics", OPTICS_COMPOSITE_WGSL, { streak: opticsGain[base].streak, halo: opticsGain[base].halo, bloom: 0.3, streakTint: [0.95, 0.98, 1, 1] }, [["streak2", "out"], ["halo", "out"], ["bloomUp0", "out"]], [-500, 0]);

  // ── Lens and grade ──
  if (base === "wheel" && driven !== undefined) {
    // Counter digits floating off the door, locked to the car as it drives (tracking.ts).
    const up: [number, number, number] = [0, 1, 0];
    // The row stands across the camera's view, just behind the front wheel, off the car's side:
    // along the car's right (screen left to right from this camera), upright.
    const across: [number, number, number] = [driven.right[0], driven.right[1], driven.right[2]];
    const o: [number, number, number] = [
      driven.pivot[0] + driven.right[0] * 1.02 - driven.forward[0] * 1.5,
      0.08,
      driven.pivot[2] + driven.right[2] * 1.02 - driven.forward[2] * 1.5,
    ];
    pass("glyphs", GLYPHS_WGSL, { ...cameraParams, origin: o, ...follow("origin", o, driven.forward), axisU: across, axisV: up, value: expressionSlot("floor(abstime * 7) * 13 % 1000", 0), digits: 3, height: 0.55, gain: 3 }, [depth], [-400, 0]);
  }
  const snapBlur: Record<string, StoredParameter> =
    shot === "zoom" ? { zoomBlur: expressionSlot("0.22 * max(1 - abs(abstime - 1.5) / 0.12, 0) ^ 2", 0) }
    : shot === "title" ? { whip: expressionSlot(`0.16 * ${WHIP}`, 0), distortion: 0.12, edgeBlur: 0.02 }
    : {};
  pass("lens", LENS_WGSL, plan.whiteRoom ? { distortion: 0.03, edgeBlur: 0.012, vignette: 0.8, vignetteRound: 0.9 } : { distortion: 0.06, edgeBlur: 0.014, vignette: 0.6, ...snapBlur }, [], [-300, 0]);
  const grade: Record<Base, Record<string, StoredParameter>> = {
    wheel: { exposure: 0.35, black: 0.04, contrast: 1.2, saturation: 0.22, steel: [0.94, 0.99, 1.04], shadowTint: [0.97, 1, 1.03, 1] },
    tableau: { exposure: 0.2, black: 0.04, contrast: 1.2, saturation: 0.22, steel: [0.94, 0.99, 1.04], shadowTint: [0.97, 1, 1.03, 1] },
    title: { exposure: 0.4, black: 0.035, contrast: 1.15, saturation: 0.3, steel: [0.95, 0.99, 1.03], shadowTint: [0.98, 1, 1.02, 1] },
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
  if (shot === "prism") {
    pass("prism", PRISM_WGSL, { centre: [0.5, 0.56], radius: 0.62, depth: 1, loss: 0.3, rotation: expressionSlot("sin(abstime * 0.4) * 0.06", 0) }, [], [400, 0]);
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
