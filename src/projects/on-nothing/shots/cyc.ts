import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../../examples/documents/builders.ts";
import { bloomPyramidGraph } from "../../../examples/bloom-pyramid.ts";
import { GTAO_WGSL } from "../../furnace/screen-space.ts";
import { CRT_WGSL, LENS_WGSL } from "../fx.ts";
import type { Bone, OnNothingFacts } from "../scene-facts.ts";
import { SKIN_ATTRIBUTES, boneParam, skinKernel, yawFor } from "../skin-kernel.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { CYC_ENVIRONMENT_WGSL, CYC_FINISH_WGSL, CYC_MIST_WGSL } from "./cyc-finish.ts";
import { NORMAL_WALK, armPose, keyedExpression, poseKeys, standingLegs, walkExpressions, type GaitStyle, type KeyPose, type Pose } from "./gait.ts";

/**
 * T1407b (cyc) — THE WHITE LIMBO: the reference's two cyc framings, built from its frames.
 *
 * MEASURED (ref.mp4, 1920×818 at 23.976; frames in the session scratchpad, sRGB 0–255):
 *
 *  `cyc` — 1:17.46–1:19.05, 38 frames. A LOW tracking shot of the legs: the lens at shin
 *   height (~0.3 m), long-ish (~15° vertical), the frame from the floor to the knee. The walker
 *   crosses toward camera-left, three-quarter to the lens, and the camera trucks with him, so
 *   the feet hold their place in frame (±15 px over the shot). It is slow motion: one swing
 *   phase takes ~13 frames where a real walk takes ~5, so ≈0.5× a 1.1 s stride. The key is
 *   hard and low from screen right, a little in front: long shadows run LEFT and away, shadow
 *   ÷ lit floor ≈ 0.6 in display (89 vs 120–146), soft-edged a hand's width from the shoe.
 *   The floor peaks at 175–180 (G) centre-right and falls to 27 at the left edge and 57 at the
 *   bottom-right corner: a heavy vignette plus the key's falloff across the cyc.
 *  `cyc-wide` — 1:44.55–1:46.51, 47 frames. A HIGH wide (~24 mm, barrel-distorted): a man
 *   chest-up in the left third, a metre and a half from the lens, a second man full length on
 *   the right third 5 m away, looking down at his hands, then throwing his right arm straight
 *   up. From the far man's feet a long, faint shadow runs up-left across the floor: 165 vs 189
 *   at the feet, 177 vs 194 at the hips, 191 vs 196 at the head — its penumbra widens and it
 *   fades with distance from the caster (an area key, low, from behind the camera's right).
 *   The cyc peaks at 197–200 (G); the sides fall to 105–135, the corners to 60–90.
 *
 *  COLOUR, both: R = G^1.22, B = G^0.97 in display (cyc 190/202/199, corners 60/80/85,
 *   blacks 11/13/15); the clothes sit at 9–15. Grain after the encode: σ < 0.4 levels.
 *  ECHO: every moving edge drags a trail of 3–5 discrete copies, each softened, fading
 *   ~0.55× per frame step — in the wide the near man's head is a stack of ghosts; in the legs
 *   the swinging shoe drags a grey smear. The trail is over the whole frame.
 *  CAMERA: handheld in both; the wide drifts and rolls a fraction of a degree.
 */

export const CYC_SHOTS = ["cyc", "cyc-wide"] as const;
export type CycShot = (typeof CYC_SHOTS)[number];

export interface CycOptions {
  readonly shot: CycShot;
  readonly width?: number;
  readonly height?: number;
  readonly crt?: boolean;
}

/**
 * The trail steps one OUTPUT frame per copy. render.ts renders `--sub` frames per output frame
 * (`--final`: 4, averaged — the shutter's smear), so the echo reads its delay off the clock:
 * one output frame (1/24 s) is 1 / (24 · delta) rendered frames. Up to 8 sub-frames.
 */
const TRAIL_DELAY = "min(8, max(1, round(1 / max(24 * delta, 0.001))))";

function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

type V3 = readonly [number, number, number];
const vec = (v: V3): number[] => [v[0], v[1], v[2]];
const f = (v: number, d = 5): string => (v < 0 ? `(${v.toFixed(d)})` : v.toFixed(d));

/** A figure in the shot: where it stands, which way it faces, and what it does. */
interface Figure {
  readonly id: string;
  readonly at: V3;
  readonly facing: V3;
  /** A walk (the root travels along the facing) … */
  readonly walk?: GaitStyle;
  /** … on its own clock (seconds of walk per abstime; an expression), so it can slow to a halt. */
  readonly clock?: string;
  /** … or a performance: poses held at times, eased between (Catmull–Rom per knob axis). */
  readonly performance?: readonly KeyPose[];
  /** Rhythm on top of the performance: knob axis → an expression added to its keys (radians). */
  readonly groove?: Record<string, string>;
}

interface Handheld {
  /** Position wander (m), aim wander (m at the target), roll (radians). */
  readonly position: number;
  readonly aim: number;
  readonly roll: number;
  readonly seed: number;
}

interface CycPlan {
  readonly figures: readonly Figure[];
  readonly camera: {
    readonly eye: V3;
    readonly lookAt: V3;
    readonly fov: number;
    /** The camera trucks with this figure's walk, eye and target together (a dolly beside the walker). */
    readonly follow?: string;
    /** A slow drift of the aim (m/s at the target): the operator easing the frame over. */
    readonly pan?: V3;
    readonly handheld: Handheld;
  };
  /** The key: its travel direction, intensity, and the angular radius of the source (penumbra). */
  readonly key: { readonly direction: V3; readonly intensity: number; readonly radius: number };
  readonly fill: number;
  /**
   * A soft top light (no shadow), so the floor takes as much light as the wall: a low key lights
   * the wall ~3× harder than the floor, and the cove would show as a seam. The reference's cyc
   * runs floor to wall without one.
   */
  readonly top?: number;
  readonly finish: Record<string, number>;
  readonly lens: Record<string, number>;
  readonly echo: { readonly trail: number; readonly darken: number };
}

/**
 * A slow, loose walk: the reference's is slow motion (≈0.5×) of an easy stride — passing at
 * 1:17.46 (t 0), the far foot's heel strike at +0.54 s — and then it comes to a halt with
 * the legs apart (1:18.3 on the feet barely move): the walk runs on a clock that eases from
 * full pace to an eighth of it between 0.62 s and 1.12 s. The whole gait (root included) is
 * warped together, so a planted shoe stays planted as it slows.
 */
const REFERENCE_WALK: GaitStyle = { ...NORMAL_WALK, period: 1.15, rate: 0.42, stride: 0.95, phase0: 0.303 };
const easeTo = (t0: number, span: number, rate: number): string => {
  const d = `clamp(abstime - ${t0}, 0, ${span})`;
  return `(min(abstime, ${t0}) + ${d} - ${(1 - rate) / (2 * span)} * ${d} ^ 2 + ${rate} * max(abstime - ${t0 + span}, 0))`;
};
const WALKER_CLOCK = easeTo(0.3, 0.3, 0.03);

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The near man of the wide (1:44.55 on): talks to the lens, points across at the far man, then drops his head. */
function nearPerformance(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.11, 0.3);
  const relaxed = armPose(bones, "L", { flex: -4, out: 6, elbow: 18 });
  // The forearm across the chest, up past the chin, the finger out to the far man.
  const point = armPose(bones, "R", { flex: 80, out: -15, elbow: 60, inward: 45, wrist: [-0.1, 0, 0.25] });
  const pointLow = armPose(bones, "R", { flex: 68, out: -10, elbow: 70, inward: 50, wrist: [0, 0, 0.2] });
  const down = armPose(bones, "R", { flex: 8, out: 4, elbow: 30 });
  const face = (pitch: number, turn: number, tilt = 0): Pose => ({ neck: [pitch * 0.6, turn * 0.6, tilt], head: [pitch * 0.4, turn * 0.4, tilt * 0.5] });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, relaxed, ...parts);
  return [
    { t: 0.0, pose: pose(point, face(0.02, -0.08, 0.06), { chest: [0, 0.12, 0] }) },
    { t: 0.22, pose: pose(point, face(0.08, -0.04, 0.04), { chest: [0, 0.14, 0] }) },
    { t: 0.42, pose: pose(point, face(-0.02, -0.1, 0.07), { chest: [0, 0.12, 0] }) },
    { t: 0.62, pose: pose(pointLow, face(0.04, -0.06, 0.05), { chest: [0, 0.1, 0] }) },
    { t: 0.85, pose: pose(down, face(0.06, -0.05, 0.03), { chest: [0, 0.03, 0] }) },
    { t: 0.95, pose: pose(down, face(0.1, 0.05, 0), { chest: [0.03, 0, 0] }) },
    { t: 1.22, pose: pose(down, face(0.62, 0.42, -0.05), { chest: [0.1, 0.1, 0], spine: [0.06, 0.05, 0] }) },
    { t: 1.45, pose: pose(down, face(0.5, 0.3, -0.02), { chest: [0.08, 0.08, 0], spine: [0.05, 0.04, 0] }) },
    { t: 1.68, pose: pose(down, face(0.68, 0.46, -0.08), { chest: [0.12, 0.12, 0], spine: [0.07, 0.06, 0] }) },
    { t: 2.0, pose: pose(down, face(0.55, 0.36, -0.04), { chest: [0.09, 0.1, 0], spine: [0.06, 0.05, 0] }) },
  ];
}

/**
 * The near man rides the beat while he talks and harder once his head drops (1:45.8 on): the
 * nods and the sway are what the echo turns into a stack of ghosts.
 */
const BEAT = 2 * Math.PI * 2.4;
const ramp = "clamp((abstime - 1.05) / 0.25, 0, 1)";
const NEAR_GROOVE: Record<string, string> = {
  "neck.x": `(0.05 + 0.13 * ${ramp}) * sin(${BEAT.toFixed(4)} * abstime)`,
  "neck.z": `(0.03 + 0.08 * ${ramp}) * sin(${(BEAT / 2).toFixed(4)} * abstime + 0.7)`,
  "chest.y": `(0.03 + 0.07 * ${ramp}) * sin(${(BEAT / 2).toFixed(4)} * abstime + 1.9)`,
  "spine.x": `0.03 * ${ramp} * sin(${BEAT.toFixed(4)} * abstime + 0.4)`,
};

/** The far man: hunched over his hands at the waist, hands up to the chest, then straightens and throws his left arm up. */
function farPerformance(bones: readonly Bone[]): KeyPose[] {
  const legs = standingLegs(bones, 0.13, -0.5, 12);
  const hunch: Pose = { spine: [0.2, 0.05, 0], chest: [0.16, 0, 0], neck: [0.45, -0.1, 0], head: [0.25, 0, 0] };
  const upright: Pose = { spine: [0.02, 0, 0], chest: [0.0, 0, 0], neck: [-0.05, 0, 0], head: [0, 0, 0] };
  const lookUp: Pose = { spine: [-0.04, 0, 0], chest: [-0.06, 0, 0.03], neck: [-0.3, 0.15, 0.05], head: [-0.2, 0.1, 0] };
  const waist = (side: "L" | "R", spread: number): Pose => armPose(bones, side, { flex: 28 + spread, out: 2, elbow: 92, inward: 32 });
  const chest = (side: "L" | "R", spread: number): Pose => armPose(bones, side, { flex: 40 + spread, out: 6, elbow: 118, inward: 30 });
  const raised = (wave: number): Pose => armPose(bones, "L", { flex: 168, out: 12 + wave, elbow: 12 + wave, inward: 0, wrist: [-0.2, 0, 0] });
  const rest = armPose(bones, "R", { flex: -4, out: 6, elbow: 18 });
  const pose = (...parts: Pose[]): Pose => Object.assign({}, legs, ...parts);
  return [
    { t: 0.0, pose: pose(hunch, waist("L", 0), waist("R", 4)) },
    { t: 0.2, pose: pose(hunch, waist("L", 5), waist("R", -2)) },
    { t: 0.42, pose: pose(hunch, waist("L", -3), waist("R", 6)) },
    { t: 0.7, pose: pose({ ...hunch, spine: [0.14, 0.04, 0], neck: [0.4, -0.15, 0] }, chest("L", 0), chest("R", 3)) },
    { t: 0.95, pose: pose({ ...upright, neck: [0.25, -0.1, 0] }, chest("L", 6), chest("R", -4)) },
    { t: 1.12, pose: pose(upright, chest("L", 12), armPose(bones, "R", { flex: 10, out: 6, elbow: 40 })) },
    { t: 1.36, pose: pose(lookUp, armPose(bones, "L", { flex: 120, out: 20, elbow: 55, inward: 5 }), armPose(bones, "R", { flex: 0, out: 5, elbow: 22 })) },
    { t: 1.55, pose: pose(lookUp, raised(0), rest) },
    { t: 1.78, pose: pose(lookUp, raised(6), rest) },
    { t: 2.0, pose: pose(lookUp, raised(0), rest) },
  ];
}

function plan(shot: CycShot, bones: readonly Bone[]): CycPlan {
  switch (shot) {
    case "cyc": {
      // The walker crosses toward camera-left, turned a little toward the lens; the camera
      // trucks with him at shin height, so his feet hold their place in frame.
      const facing = unit([-0.95, 0, 0.3]);
      const at: V3 = [1.0, 0, 0.0];
      return {
        figures: [{ id: "walker", at, facing, walk: REFERENCE_WALK, clock: WALKER_CLOCK }],
        camera: {
          eye: [at[0] + 0.12, 0.85, at[2] + 3.1],
          lookAt: [at[0] + 0.12, 0.22, at[2]],
          fov: 15,
          follow: "walker",
          handheld: { position: 0.004, aim: 0.008, roll: -0.005, seed: 1 },
        },
        key: { direction: [-0.55, -0.5, -0.67], intensity: 4.6, radius: 0.06 },
        fill: 0.8,
        finish: { exposure: -1.42, peak: 0.71, vignette: 0.52, vignetteRadius: 1.0, vignetteHardness: 4, vignetteHeight: 0.5, vignetteBias: 0.06, broad: 0.1 },
        lens: { distortion: 0.02, edgeBlur: 0.01, swirl: 0.4, aberration: 0.001, vignette: 0 },
        echo: { trail: 0.5, darken: 0.2 },
      };
    }
    case "cyc-wide":
      // The lens at the near man's eye line (1.72 m), 6° down, ~24 mm: the near man 1.1 m off at the left third, the far
      // man 5 m off at the right third, 1.2 m in front of the wall, so a low key from the
      // camera's right throws his whole silhouette up it, a metre to his right.
      return {
        figures: [
          { id: "near", at: [-0.25, 0, -0.67], facing: unit([0.3, 0, 0.95]), performance: nearPerformance(bones), groove: NEAR_GROOVE },
          { id: "far", at: [1.35, 0, -4.7], facing: unit([-0.6, 0, 0.8]), performance: farPerformance(bones) },
        ],
        camera: {
          eye: [0, 1.72, 0.4],
          lookAt: [0.25, 1.08, -5.6],
          fov: 25,
          // Measured off the far man's shoes: the frame eases right ~50 px/s and down ~20 px/s.
          pan: [0.15, -0.05, 0],
          handheld: { position: 0.006, aim: 0.012, roll: -0.006, seed: 2 },
        },
        key: { direction: [-0.62, -0.1, -0.78], intensity: 1.1, radius: 0.05 },
        fill: 0.9,
        // key × (its cosine on the wall − on the floor)
        top: 1.1 * (0.78 - 0.1),
        finish: { exposure: -0.62, saturation: 0.6, peak: 0.79, vignette: 0.47, vignetteRadius: 1.02, vignetteHardness: 7.5, vignetteHeight: 0.45, broad: 0.1 },
        lens: { distortion: 0.07, edgeBlur: 0.014, swirl: 0.5, aberration: 0.0015, vignette: 0 },
        echo: { trail: 0.62, darken: 0.15 },
      };
  }
}

/** Sums of incommensurate sines: a hand-held drift that never repeats inside a shot. */
function wander(amplitude: number, seed: number, axis: number): string {
  const r = (k: number): number => {
    const x = Math.sin(seed * 12.9898 + axis * 78.233 + k * 37.719) * 43758.5453;
    return x - Math.floor(x);
  };
  const terms = [
    [0.55, 0.9 + r(1) * 0.5],
    [0.3, 2.1 + r(2) * 0.9],
    [0.15, 5.3 + r(3) * 2.0],
  ].map(([a, w], k) => `${f(amplitude * a!)} * sin(${f(w! * 2 * Math.PI, 4)} * abstime + ${f(r(k + 7) * 6.283, 4)})`);
  return terms.join(" + ");
}

export function cycDocument(facts: OnNothingFacts, options: CycOptions): ProjectDocument {
  const p = plan(options.shot, facts.bones);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const scenes: string[] = [];
  const lights: string[] = [];

  nodes.push(node("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: SURFACE_WGSL, cycAlbedo: 0.9 }, { label: "material_surf" }));

  // The wide stands its far man by a tight-cove wall (cyc_set.py); the legs walk the big cyc.
  const cyc = (options.shot === "cyc-wide" ? facts.areas.get("cycwide") : undefined) ?? facts.areas.get("cyc");
  if (cyc === undefined) throw new Error("cycDocument: no cyc area in the GLB.");
  nodes.push(node("mesh_cyc", "meshFileIn", [-3600, 0], { file: facts.glbUrl, select: cyc.select, vertices: cyc.vertices, triangles: cyc.triangles, parts: cyc.parts }, { label: "mesh_cyc" }));
  nodes.push(node("geo_cyc", "geometry", [-3300, 0], { mode: "surface", material: "material_surf" }, { label: "geometry_cyc" }));
  edges.push(edge("mesh-geo-cyc", ["mesh_cyc", "out"], ["geo_cyc", "points"]));
  scenes.push("geometry_cyc");

  // ── The figures: one mesh, one skin kernel each ──
  // The wardrobe the reference's walker wears (cyc_wardrobe.py); an older GLB has only the suit.
  const mesh = facts.areas.get("figcyc") ?? facts.areas.get("fig");
  if (mesh === undefined) throw new Error("cycDocument: no figure in the GLB.");
  nodes.push(node("fig", "meshFileIn", [-3600, 1200], { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts, joints: mesh.joints }, { label: "mesh_fig" }));
  const known = new Set(facts.bones.map(boneParam));
  /** Each walker's steady velocity (m/s, world), for a camera that follows it. */
  const velocity = new Map<string, { v: V3; clock: string }>();
  p.figures.forEach((figure, index) => {
    const pose: Record<string, StoredParameter> = {};
    const setKnob = (key: string, value: string | number): void => {
      const [bone, axis] = key.split(".");
      if (bone === undefined || !known.has(bone)) throw new Error(`cyc ${figure.id}: no bone "${bone}".`);
      if (axis !== "x" && axis !== "y" && axis !== "z") throw new Error(`cyc ${figure.id}: "${key}" names no axis.`);
      if (pose[bone] === undefined) pose[bone] = [0, 0, 0];
      pose[key] = typeof value === "number" ? expressionSlot(f(value), value) : expressionSlot(value, 0);
    };
    const yaw = yawFor(figure.facing);
    const [fx, , fz] = figure.facing;
    // Figure-local x (its left) in the world: the kernel's turn applied to +X.
    const left: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    let place: Record<string, StoredParameter> = { place: vec(figure.at) };
    if (figure.walk !== undefined) {
      const walk = walkExpressions(facts.bones, figure.walk, figure.clock ?? "abstime");
      velocity.set(figure.id, { v: [fx * walk.speed, 0, fz * walk.speed], clock: figure.clock ?? "abstime" });
      for (const [key, source] of Object.entries(walk.knobs)) setKnob(key, source);
      const along = (axis: 0 | 2, forward: number, side: number): string =>
        `${f(figure.at[axis])} + ${f(forward)} * (${walk.root.z}) + ${f(side)} * (${walk.root.x})`;
      place = {
        place: vec(figure.at),
        "place.x": expressionSlot(along(0, fx, left[0]), figure.at[0]),
        "place.y": expressionSlot(`${f(figure.at[1])} + ${walk.root.y}`, figure.at[1]),
        "place.z": expressionSlot(along(2, fz, left[2]), figure.at[2]),
      };
    }
    if (figure.performance !== undefined) {
      const keyed = poseKeys(figure.performance);
      const groove = figure.groove ?? {};
      for (const key of new Set([...Object.keys(keyed), ...Object.keys(groove)])) {
        const parts = [keyed[key] === undefined ? undefined : keyedExpression(keyed[key]!), groove[key]].filter((part) => part !== undefined);
        setKnob(key, parts.map((part) => `(${part})`).join(" + "));
      }
    }
    const id = `skin_${figure.id}`;
    nodes.push(node(id, "pointKernel", [-3300, 1200 + index * 200], { capacity: mesh.vertices, attributes: SKIN_ATTRIBUTES, kernel: skinKernel(facts), yaw, ...place, ...pose }, { label: `kernel_skin${figure.id}` }));
    nodes.push(node(`geo_${figure.id}`, "geometry", [-3000, 1200 + index * 200], { mode: "surface", material: "material_surf" }, { label: `geometry_${figure.id}` }));
    edges.push(edge(`fig-${id}`, ["fig", "out"], [id, "in"]));
    edges.push(edge(`${id}-geo`, [id, "out"], [`geo_${figure.id}`, "points"]));
    scenes.push(`geometry_${figure.id}`);
  });

  // ── Light: the key as a small AREA source (jittered casters: the penumbra widens with
  //    distance from the caster, as the reference's does), and a soft fill ──
  const key = p.key;
  const d = key.direction;
  const dl = Math.hypot(d[0], d[1], d[2]);
  const axis: V3 = [d[0] / dl, d[1] / dl, d[2] / dl];
  const u0 = [axis[2], 0, -axis[0]];
  const ul = Math.hypot(u0[0]!, u0[2]!);
  const uAxis: V3 = [u0[0]! / ul, 0, u0[2]! / ul];
  const vAxis: V3 = [axis[1] * uAxis[2] - axis[2] * uAxis[1], axis[2] * uAxis[0] - axis[0] * uAxis[2], axis[0] * uAxis[1] - axis[1] * uAxis[0]];
  const TAPS = 6;
  for (let i = 0; i < TAPS; i++) {
    // A disc of directions: one in the middle, the rest on a ring at 0.8 of the radius.
    const ring = i === 0 ? 0 : key.radius * 0.8;
    const a = (2 * Math.PI * i) / (TAPS - 1);
    const dir = [0, 1, 2].map((c) => axis[c]! + ring * (Math.cos(a) * uAxis[c]! + Math.sin(a) * vAxis[c]!));
    nodes.push(node(`key${i}`, "light", [-2600, 1000 + i * 60], { kind: "directional", direction: dir, color: [1, 1, 1, 1], intensity: key.intensity / TAPS, shadows: true, shadowExtent: 7, shadowSoftness: 2 }, { label: `light_key${i}` }));
    lights.push(`light_key${i}`);
  }
  if (p.top !== undefined && p.top > 0) {
    nodes.push(node("top", "light", [-2600, 1500], { kind: "directional", direction: [0, -1, 0], color: [1, 1, 1, 1], intensity: p.top }, { label: "light_top" }));
    lights.push("light_top");
  }

  // ── Environment (the white room, for the figure's sheen) ──
  nodes.push(node("envSeed", "ramp", [-2700, 300], {}, { label: "ramp_envseed", resolution: { mode: "fixed", width: 512, height: 256 } }));
  // The cyc lies toward the camera's view; the key's source stands where its light comes from.
  const toward = unit([p.camera.lookAt[0] - p.camera.eye[0], 0, p.camera.lookAt[2] - p.camera.eye[2]]);
  nodes.push(node("env", "customWgsl", [-2700, 500], {
    source: CYC_ENVIRONMENT_WGSL,
    toward: vec(toward),
    wall: 1.4,
    studio: 0.03,
    keyDir: vec(unit([-p.key.direction[0], -p.key.direction[1], -p.key.direction[2]])),
    keyGain: 1.2,
    keySize: 0.4,
  }, { label: "wgsl_env", resolution: { mode: "fixed", width: 512, height: 256 } }));
  edges.push(edge("seed-env", ["envSeed", "out"], ["env", "input"]));

  // ── Camera: a truck with the walker (or not), and a hand on it ──
  const cam = p.camera;
  const followed = cam.follow === undefined ? undefined : velocity.get(cam.follow);
  const truck: V3 = followed?.v ?? [0, 0, 0];
  const truckClock = followed?.clock ?? "abstime";
  const hh = cam.handheld;
  const pan: V3 = cam.pan ?? [0, 0, 0];
  const move = (base: number, axisIndex: number, amplitude: number, salt: number, drift = 0): string =>
    `${f(base)} + ${f(truck[axisIndex]!)} * (${truckClock}) + ${f(drift)} * abstime + ${wander(amplitude, hh.seed, salt)}`;
  const cameraParams: Record<string, StoredParameter> = {
    eye: vec(cam.eye),
    lookAt: vec(cam.lookAt),
    "eye.x": expressionSlot(move(cam.eye[0], 0, hh.position, 1), cam.eye[0]),
    "eye.y": expressionSlot(move(cam.eye[1], 1, hh.position, 2), cam.eye[1]),
    "eye.z": expressionSlot(move(cam.eye[2], 2, hh.position, 3), cam.eye[2]),
    "lookAt.x": expressionSlot(move(cam.lookAt[0], 0, hh.aim, 4, pan[0]), cam.lookAt[0]),
    "lookAt.y": expressionSlot(move(cam.lookAt[1], 1, hh.aim, 5, pan[1]), cam.lookAt[1]),
    "lookAt.z": expressionSlot(move(cam.lookAt[2], 2, hh.aim, 6, pan[2]), cam.lookAt[2]),
    roll: expressionSlot(wander(hh.roll, hh.seed, 7), 0),
    fov: cam.fov,
  };
  nodes.push(node("cam", "camera", [-2700, -900], { near: 0.05, far: 100, ...cameraParams }, { label: "camera1" }));
  const aim: V3 = cam.lookAt;
  const cameraRef = (field: string, fallback: number): StoredParameter => expressionSlot(`op('camera1').par.${field}`, fallback);
  const passCamera: Record<string, StoredParameter> = {
    eye: vec(cam.eye),
    aim: vec(aim),
    "eye.x": cameraRef("eye.x", cam.eye[0]),
    "eye.y": cameraRef("eye.y", cam.eye[1]),
    "eye.z": cameraRef("eye.z", cam.eye[2]),
    "aim.x": cameraRef("lookAt.x", aim[0]),
    "aim.y": cameraRef("lookAt.y", aim[1]),
    "aim.z": cameraRef("lookAt.z", aim[2]),
    fov: cameraRef("fov", cam.fov),
    far: cameraRef("far", 100),
    roll: cameraRef("roll", 0),
  };

  nodes.push(node("shot", "render", [-2400, 0], {
    scenes: scenes.join(" "),
    camera: "camera1",
    lights: lights.join(" "),
    projectors: "",
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: p.fill,
    background: [0.8, 0.8, 0.8, 1],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    albedoOutput: true,
    environmentIntensity: 0.25,
    environmentTaps: 16,
  }, { label: "render_shot" }));
  edges.push(edge("env-shot", ["env", "out"], ["shot", "environment"]));

  let last: readonly [string, string] = ["shot", "out"];
  const pass = (id: string, source: string, extra: Record<string, StoredParameter>, more: readonly (readonly [string, string])[], position: readonly [number, number]): void => {
    nodes.push(node(id, more.length > 0 ? "customWgslMulti" : "customWgsl", position, { source, ...extra }, { label: `wgsl_${id.toLowerCase()}`, resolution: { mode: "project" } }));
    edges.push(edge(`${last[0]}-${id}`, last, [id, "input"]));
    more.forEach((port, index) => edges.push(edge(`${id}-more${index}`, port, [id, "more"], index)));
    last = [id, "out"];
  };
  // Contact occlusion under the shoes.
  pass("occlusion", GTAO_WGSL, { ...passCamera, radius: 0.35, strength: 0.55 }, [["shot", "depth"], ["shot", "normal"]], [-2100, 0]);
  const scene = last;

  // ── Diffusion: the whole picture, blurred wide (the bloom pyramid with no threshold) ──
  const bloom = bloomPyramidGraph({
    ids: { bright: "bright", down: ["bloomDown1", "bloomDown2", "bloomDown3", "bloomDown4"], up: ["bloomUp0", "bloomUp1", "bloomUp2", "bloomUp3"] },
    edgePrefix: "bloom", layout: { bright: [-1300, 300], down: [-900, 300], up: [-700, 150], step: [0, 150] },
    threshold: 0, knee: 0.001, firstClampLuma: 0, lower: 1.4,
  });
  nodes.push(...bloom.nodes);
  edges.push(...bloom.edges);
  edges.push(edge("scene-bright", scene, ["bright", "input"]));
  pass("mist", CYC_MIST_WGSL, { amount: 0.14 }, [["bloomUp0", "out"]], [-500, 0]);
  pass("lens", LENS_WGSL, p.lens, [], [-300, 0]);
  pass("finish", CYC_FINISH_WGSL, p.finish, [], [-100, 0]);

  // ── The trail: copies one output frame apart (the shutter's smear is render.ts's sub-frames) ──
  nodes.push(node("trail", "echo", [300, 0], { amount: p.echo.trail, darken: p.echo.darken, delay: expressionSlot(TRAIL_DELAY, 1), frames: 9 }, { label: "echo_trail" }));
  edges.push(edge("finish-trail", last, ["trail", "input"]));
  last = ["trail", "out"];
  if (options.crt === true) pass("crt", CRT_WGSL, { amount: 1 }, [], [500, 0]);
  nodes.push(node("out", "output", [700, 0], { toneMap: "none" }, { label: "output1" }));
  edges.push(edge("last-out", last, ["out", "input"]));

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: `project-on-nothing-${options.shot}`,
    name: `On Nothing · ${options.shot}`,
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
