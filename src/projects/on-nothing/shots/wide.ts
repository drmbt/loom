import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import type { DecodedMarker } from "../../../domain/mesh/glb.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import type { Bone, MeshSelectionFacts, OnNothingFacts } from "../scene-facts.ts";
import { carAreas, wgslVec3 } from "../scene-facts.ts";
import { CAR_RIG_ATTRIBUTES } from "../car-rig.ts";
import { SKIN_ATTRIBUTES, boneParam, skinKernel } from "../skin-kernel.ts";
import { handheld, type HandheldOptions } from "./handheld.ts";
import { keyedExpression, poseKeys, walkExpressions, type GaitStyle, type KeyPose } from "./gait.ts";
import { addNode, connect, dropParams, finish, setParams, surgery, type Surgery } from "./splice.ts";
import type { Build, ShotOptions } from "./halo.ts";
import { WIDE_TAKES, type WideTake } from "./wide-takes.ts";
export type { WideTake };

/**
 * T1407b (wide) — THE WIDE WAREHOUSE COVERAGE: the tableau's set (the five cars, the figure,
 * the headlight columns) seen by the other cameras of the reference (rows 10, 11, 13, 19, 34,
 * 37, 38, 40, 43, 54, 56, 63, 69, 82, 87 and 92 of docs/on-nothing-shotlist-2026-09-27.md).
 *
 * Built on the tableau's graph (document.ts) by surgery, as halo and crt are: the same room,
 * haze, streak glass, bloom, lens and grade. Each TAKE (shots/wide-takes.ts) re-parks the cars
 * (a Point Kernel turns and moves each car's mesh and its lamp glass about the car's centre;
 * the lamps, their projectors, their haze and the floor's contact shadows follow through the
 * facts), re-aims the camera (least-squares fitted to the reference's headlight blobs where
 * the cars read, by eye elsewhere), and re-poses the figure — or two of them (row 69).
 */

type V3 = readonly [number, number, number];

/** A car of the tableau, turned about its own centre (radians, + turns the nose toward +x) and moved (metres). */
export interface CarMove {
  readonly place?: readonly [number, number];
  readonly turn?: number;
}

/** The rest centre of a car's footprint (the pivot it turns about), on the floor. */
function centreOf(area: MeshSelectionFacts): V3 {
  const b = area.bounds;
  return [(b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2];
}

function turnAbout(p: V3, pivot: V3, turn: number, place: readonly [number, number]): [number, number, number] {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const x = p[0] - pivot[0];
  const z = p[2] - pivot[2];
  return [pivot[0] + x * c + z * s + place[0], p[1], pivot[2] - x * s + z * c + place[1]];
}

function turnDir(d: V3, turn: number): [number, number, number] {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return [d[0] * c + d[2] * s, d[1], -d[0] * s + d[2] * c];
}

/**
 * The facts as the take parks the cars: each moved car's lamps (and their aim), its footprint
 * bounds; a hidden car has no area and no lamps, so the tableau builds no mesh, no projector
 * and no haze cone for it.
 */
export function parkedFacts(facts: OnNothingFacts, cars: WideTake["cars"]): OnNothingFacts {
  if (cars === undefined) return facts;
  const areas = new Map(facts.areas);
  const markers = new Map(facts.markers);
  for (const area of carAreas(facts)) {
    const index = Number(area.slice(3));
    const move = cars[index];
    if (move === undefined) continue;
    const lamps = [...markers.keys()].filter((name) => name.startsWith(`lamp.head.${index}`));
    if (move === "hide") {
      areas.delete(area);
      lamps.forEach((name) => markers.delete(name));
      continue;
    }
    const rest = facts.areas.get(area)!;
    const pivot = centreOf(rest);
    const turn = move.turn ?? 0;
    const place = move.place ?? [0, 0];
    const corners = [0, 1, 2, 3].map((k) => turnAbout([k & 1 ? rest.bounds.max[0] : rest.bounds.min[0], 0, k & 2 ? rest.bounds.max[2] : rest.bounds.min[2]], pivot, turn, place));
    areas.set(area, {
      ...rest,
      bounds: {
        min: [Math.min(...corners.map((c) => c[0])), rest.bounds.min[1], Math.min(...corners.map((c) => c[2]))],
        max: [Math.max(...corners.map((c) => c[0])), rest.bounds.max[1], Math.max(...corners.map((c) => c[2]))],
      },
    });
    for (const name of lamps) {
      const marker = markers.get(name)!;
      const dir = marker.extras?.["loom_light_dir"] as number[] | undefined;
      const moved: DecodedMarker = {
        ...marker,
        position: turnAbout(marker.position, pivot, turn, place),
        extras: { ...marker.extras, ...(dir === undefined ? {} : { loom_light_dir: turnDir([dir[0]!, dir[1]!, dir[2]!], turn) }) },
      };
      markers.set(name, moved);
    }
  }
  return { ...facts, areas, markers };
}

/**
 * The parking kernel: every point finds the car whose rest footprint holds it and is turned
 * about that car's centre and moved with it (a hidden car's lamp glass sinks out of sight).
 * One kernel serves each car's mesh and the shared lamp-glass mesh.
 */
function parkingKernel(facts: OnNothingFacts): string {
  const cars = carAreas(facts).map((area) => ({ index: Number(area.slice(3)), rest: facts.areas.get(area)! }));
  const params = cars.map(({ index }) => `  place${index}: vec3f, // @default 0  Car ${index} moved from its mark (metres).\n  turn${index}: f32, // @default 0  Car ${index} turned about its centre (radians, + noses toward +x).`).join("\n");
  const branches = cars.map(({ index, rest }) => {
    const pad = 0.12;
    const lo = wgslVec3([rest.bounds.min[0] - pad, -1, rest.bounds.min[2] - pad]);
    const hi = wgslVec3([rest.bounds.max[0] + pad, 4, rest.bounds.max[2] + pad]);
    return `  if (all(p.position >= ${lo}) && all(p.position <= ${hi})) {
    return park(p, ${wgslVec3(centreOf(rest))}, ctx.params.turn${index}, ctx.params.place${index});
  }`;
  }).join("\n");
  return `// T1407b (wide) — the parked cars (generated by src/projects/on-nothing/shots/wide.ts).
struct Params {
${params}
};

fn park(p: Point, pivot: vec3f, turn: f32, place: vec3f) -> Point {
  var q = p;
  let c = cos(turn);
  let s = sin(turn);
  let r = mat3x3f(vec3f(c, 0.0, -s), vec3f(0.0, 1.0, 0.0), vec3f(s, 0.0, c));
  q.position = pivot + r * (p.position - pivot) + place;
  q.normal = r * p.normal;
  return q;
}

fn process(p: Point, ctx: PointCtx) -> Point {
${branches}
  return p;
}`;
}

function parkingParams(facts: OnNothingFacts, cars: NonNullable<WideTake["cars"]>): Record<string, StoredParameter> {
  const out: Record<string, StoredParameter> = {};
  for (const area of carAreas(facts)) {
    const index = Number(area.slice(3));
    const move = cars[index];
    if (move === "hide") {
      out[`place${index}`] = [0, -60, 0];
      out[`turn${index}`] = 0;
      continue;
    }
    out[`place${index}`] = [move?.place?.[0] ?? 0, 0, move?.place?.[1] ?? 0];
    out[`turn${index}`] = move?.turn ?? 0;
  }
  return out;
}

/** Put a parking kernel between a mesh and its geometry (the edge the tableau drew between them). */
function park(cut: Surgery, facts: OnNothingFacts, cars: NonNullable<WideTake["cars"]>, mesh: string, geo: string, edgeId: string, capacity: number): void {
  if (cut.edges[edgeId] === undefined) throw new Error(`wideDocument: the tableau has no edge "${edgeId}".`);
  delete cut.edges[edgeId];
  const id = `park_${mesh}`;
  const at = cut.nodes[mesh]!.position;
  addNode(cut, id, "pointKernel", [at.x + 150, at.y + 60], { capacity, attributes: CAR_RIG_ATTRIBUTES, kernel: parkingKernel(facts), ...parkingParams(facts, cars) }, { label: `park${mesh.toLowerCase().replace(/_/g, "")}1` });
  connect(cut, [mesh, "out"], [id, "in"]);
  connect(cut, [id, "out"], [geo, "points"]);
}

/** A figure's performance as knob expressions: every bone's knob, keyed poses, an optional groove on top. */
export interface FigureTake {
  readonly area: "fig" | "figbare";
  /** Where it stands (x, z on the floor), or where a walk starts. */
  readonly at: readonly [number, number];
  /** Degrees about +y: 0 faces +z (the tableau's lens), 180 the cars. */
  readonly facing: number;
  readonly performance?: (bones: readonly Bone[]) => readonly KeyPose[];
  /** Extra expressions ADDED to a knob axis (`neck.x`): the groove over the keyed pose. */
  readonly groove?: Readonly<Record<string, string>>;
  /** A walk along the facing (shots/gait.ts), its clock `abstime`. */
  readonly walk?: GaitStyle;
  /** Where it stands over time, [seconds, x, z] keys (eased; holds before the first and after the last). */
  readonly path?: readonly (readonly [number, number, number])[];
  /** The root's height over time, [seconds, metres] keys (a squat sinks it). */
  readonly lift?: readonly (readonly [number, number])[];
}

function figureParams(facts: OnNothingFacts, figure: FigureTake): Record<string, StoredParameter> {
  const known = new Set(facts.bones.map(boneParam));
  const out: Record<string, StoredParameter> = {};
  for (const bone of known) out[bone] = [0, 0, 0];
  const exprs: Record<string, string> = {};
  if (figure.performance !== undefined) {
    for (const [key, keys] of Object.entries(poseKeys(figure.performance(facts.bones)))) exprs[key] = keyedExpression(keys);
  }
  const yaw = (figure.facing * Math.PI) / 180;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  let place: Record<string, StoredParameter> = { place: [figure.at[0], 0, figure.at[1]] };
  if (figure.walk !== undefined) {
    const walk = walkExpressions(facts.bones, figure.walk);
    for (const [key, value] of Object.entries(walk.knobs)) exprs[key] = value;
    // the root, figure-local (x = its left, z = forward) turned onto the floor
    const x = `(${walk.root.x})`;
    const z = `(${walk.root.z})`;
    place = {
      place: [figure.at[0], 0, figure.at[1]],
      "place.x": expressionSlot(`${figure.at[0]} + ${x} * ${fz.toFixed(5)} + ${z} * ${fx.toFixed(5)}`, figure.at[0]),
      "place.y": expressionSlot(walk.root.y, 0),
      "place.z": expressionSlot(`${figure.at[1]} - ${x} * ${fx.toFixed(5)} + ${z} * ${fz.toFixed(5)}`, figure.at[1]),
    };
  }
  if (figure.path !== undefined) {
    place = {
      place: [figure.at[0], 0, figure.at[1]],
      "place.x": expressionSlot(keyedExpression(figure.path.map(([t, x]) => [t, x] as const)), figure.at[0]),
      "place.z": expressionSlot(keyedExpression(figure.path.map(([t, , z]) => [t, z] as const)), figure.at[1]),
    };
  }
  if (figure.lift !== undefined) place = { ...place, "place.y": expressionSlot(keyedExpression(figure.lift), 0) };
  for (const [key, value] of Object.entries(figure.groove ?? {})) exprs[key] = exprs[key] === undefined ? value : `${exprs[key]} + ${value}`;
  for (const [key, value] of Object.entries(exprs)) {
    const [bone] = key.split(".");
    if (bone === undefined || !known.has(bone)) throw new Error(`wideDocument: no bone knob "${key}".`);
    out[key] = expressionSlot(value, 0);
  }
  return { yaw, ...place, ...out };
}

/** The camera: a fitted frame, the operator's hand on it, and an optional move (metres a second). */
export interface CameraTake {
  readonly eye: V3;
  readonly aim: V3;
  /** Vertical field of view, degrees. */
  readonly fov: number;
  /** The operator (shots/handheld.ts): its roll is the Dutch tilt, in degrees. */
  readonly hand: HandheldOptions;
  /** The eye's travel, metres a second (a push, a truck); the aim travels with `aimMove`. */
  readonly move?: V3;
  readonly aimMove?: V3;
  /** The zoom's travel, degrees a second. */
  readonly zoom?: number;
}

function sourceOf(parameter: StoredParameter): string {
  return (parameter as unknown as { bindings: { expression: { source: string } } }).bindings.expression.source;
}

function cameraParams(camera: CameraTake): Record<string, StoredParameter> {
  const hh = handheld(camera.eye, camera.aim, { creep: 0, ...camera.hand });
  const out: Record<string, StoredParameter> = { eye: [...camera.eye], lookAt: [...camera.aim], fov: camera.fov, roll: hh["roll"]! };
  (["x", "y", "z"] as const).forEach((axis, index) => {
    const eye = sourceOf(hh[`eye.${axis}`]!);
    const aim = sourceOf(hh[`lookAt.${axis}`]!);
    const move = camera.move?.[index] ?? 0;
    const aimMove = camera.aimMove?.[index] ?? move;
    out[`eye.${axis}`] = expressionSlot(move === 0 ? eye : `${eye} + ${move} * abstime`, camera.eye[index]!);
    out[`lookAt.${axis}`] = expressionSlot(aimMove === 0 ? aim : `${aim} + ${aimMove} * abstime`, camera.aim[index]!);
  });
  if (camera.zoom !== undefined) out["fov"] = expressionSlot(`${camera.fov} + ${camera.zoom} * abstime`, camera.fov);
  return out;
}

export function wideDocument(facts: OnNothingFacts, options: ShotOptions & { readonly take?: number }, build: Build): ProjectDocument {
  const takeIndex = options.take ?? 0;
  const take = WIDE_TAKES[takeIndex];
  if (take === undefined) throw new Error(`wideDocument: no take ${takeIndex} (there are ${WIDE_TAKES.length}: ${WIDE_TAKES.map((t, i) => `${i} ${t.name}`).join(", ")}).`);
  const parked = parkedFacts(facts, take.cars);
  const base = build(parked, { ...options, shot: "tableau" });
  const cut = surgery(base);

  // ── The cars, parked for this take ──
  if (take.cars !== undefined) {
    const cars = take.cars;
    for (const area of carAreas(parked)) {
      const index = Number(area.slice(3));
      const move = cars[index];
      if (move === undefined || move === "hide") continue;
      park(cut, facts, cars, `mesh_${area}`, `geo_${area}`, `mesh-geo-${area}`, facts.areas.get(area)!.vertices);
    }
    const glass = facts.areas.get("lampglass");
    if (glass !== undefined && cut.nodes["mesh_lampglass"] !== undefined) park(cut, facts, cars, "mesh_lampglass", "geo_lampglint", "mesh-geo-lampglint", glass.vertices);
  }

  // ── The figure(s) ──
  const figArea = facts.areas.get(take.figure.area);
  if (figArea === undefined) throw new Error(`wideDocument: no "${take.figure.area}" area in the GLB.`);
  setParams(cut, "fig", { select: figArea.select, vertices: figArea.vertices, triangles: figArea.triangles, parts: figArea.parts, joints: figArea.joints });
  dropParams(cut, "skin", Object.keys(cut.nodes["skin"]!.parameters).filter((key) => key.includes(".")));
  setParams(cut, "skin", { capacity: figArea.vertices, ...figureParams(facts, take.figure) });
  const scenes = String(cut.nodes["shot"]!.parameters["scenes"]).split(" ");
  if (take.second !== undefined) {
    // A second instance of the figure: its own mesh read, its own skin, its own geometry (row 69).
    const second = facts.areas.get(take.second.area)!;
    addNode(cut, "fig2", "meshFileIn", [-3600, 1500], { file: facts.glbUrl, select: second.select, vertices: second.vertices, triangles: second.triangles, parts: second.parts, joints: second.joints }, { label: "figb1" });
    addNode(cut, "skin2", "pointKernel", [-3300, 1500], { capacity: second.vertices, attributes: SKIN_ATTRIBUTES, kernel: skinKernel(facts), ...figureParams(facts, take.second) }, { label: "skinb1" });
    addNode(cut, "figGeo2", "geometry", [-3000, 1500], { mode: "surface", material: "surf1" }, { label: "figgeob1" });
    connect(cut, ["fig2", "out"], ["skin2", "in"]);
    connect(cut, ["skin2", "out"], ["figGeo2", "points"]);
    scenes.push("figgeob1");
  }
  setParams(cut, "shot", { scenes: scenes.join(" ") });

  // ── The camera ──
  dropParams(cut, "cam", Object.keys(cut.nodes["cam"]!.parameters).filter((key) => key.includes(".")));
  setParams(cut, "cam", cameraParams(take.camera));

  // ── Light: the cars' low key behind the lens, the soft fill on the figure ──
  const eye = take.camera.eye;
  const f = [take.camera.aim[0] - eye[0], 0, take.camera.aim[2] - eye[2]];
  const fl = Math.hypot(f[0]!, f[2]!) || 1;
  const back: V3 = [eye[0] - (f[0]! / fl) * 4, 0.45, eye[2] - (f[2]! / fl) * 4];
  const strobe = take.strobe === undefined ? "" : ` * (${take.strobe})`;
  const key = take.key ?? { position: back, intensity: 22 };
  setParams(cut, "carKey", { position: [...key.position], intensity: strobe === "" ? key.intensity : expressionSlot(`${key.intensity}${strobe}`, key.intensity) });
  const at = take.figure.at;
  const toLens = [eye[0] - at[0], eye[2] - at[1]];
  const tl = Math.hypot(toLens[0]!, toLens[1]!) || 1;
  const fill = take.fill ?? { position: [at[0] + (toLens[0]! / tl) * 1.5 - (toLens[1]! / tl) * 1.1, 2.1, at[1] + (toLens[1]! / tl) * 1.5 + (toLens[0]! / tl) * 1.1] as V3, intensity: 5 };
  setParams(cut, "fill", { position: [...fill.position], intensity: strobe === "" ? fill.intensity : expressionSlot(`${fill.intensity}${strobe}`, fill.intensity) });

  // ── Focus on the figure; the finish ──
  const focus = Math.hypot(at[0] - eye[0], 1.3 - eye[1], at[1] - eye[2]);
  setParams(cut, "lens_dof", { focusDistance: take.focus ?? focus, ...(take.aperture === undefined ? {} : { aperture: take.aperture }) });
  if (take.grade !== undefined) setParams(cut, "grade", take.grade);
  if (take.reach !== undefined) {
    // the streak glass's three passes step reach/400, reach/60, reach/20 (document.ts); a number
    // grows one way through the cut, an expression is the take's own curve
    const reach = typeof take.reach === "number" ? `(${take.reach} * (0.8 + 0.2 * clamp(abstime / 3, 0, 1)))` : `(${take.reach})`;
    const still = typeof take.reach === "number" ? take.reach : 0.3;
    [400, 60, 20].forEach((div, index) => setParams(cut, `streak${index}`, { step: expressionSlot(`${reach} / ${div}`, still / div) }));
  }
  for (const [id, parameters] of Object.entries(take.set ?? {})) setParams(cut, id, parameters);

  return finish(base, cut, `wide-${takeIndex}`);
}

