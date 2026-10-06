import type { GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { edge, expressionSlot, node } from "../../examples/documents/builders.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import { slotFromValue } from "../../domain/parameters/slots.ts";
import type { ProjectorFacts, ProjectorName, StageFacts, Vec3 } from "./facts.ts";
import { chan, fmt, shadowFovSource, vecSlots, viewSlots, type Slots } from "./slots.ts";
import { beamShader, compositeShader } from "./haze.ts";
import { applyFx } from "./fx.ts";

/**
 * Stage previz — the projector rig as controls (VN12).
 *
 * The DS (IMAG) projector hangs from its own 4' truss at the side projectors' truss height,
 * on a 0.37 short-throw lens 16' from the scrim. Ten faders drive the rig:
 *
 *   dsThrow    DS throw ratio                    → projDS.throwRatio
 *   dsOffset   DS truss z offset, FEET           → the truss, the body and the lens slide in z
 *   dsTilt     DS tilt, degrees down             → the body turns about its clamp; lens and aim follow
 *   dsKeyV/H   DS keystone, degrees              → projDS.keystoneV / keystoneH
 *   sideTilt   both side projectors, degrees down → each re-aims along its own pan line
 *   sideThrow  both side projectors' throw ratio
 *   sideRoll   both side projectors' roll, degrees: 90 is portrait. Stage right takes +roll
 *              and stage left −roll — the mirror of a roll is its negative, so with stage
 *              left's content flipped the two throws stay mirror images of each other
 *   sideKeyV/H both side projectors' keystone, degrees; H mirrored the same way (stage right
 *              takes SIDE_KEY_SIGN × the fader, stage left the opposite), V not
 *
 * Four more ride along: deckTone (the floor's grey, below), scrim (the drapes'), and orbit and zoom, which turn the
 * view camera about its shot's look-at, ±180°, and move it along its line to it, in feet —
 * to see the set from behind the scrim, or closer (slots.ts).
 *
 * The side projectors are rolled ±90° (portrait), pan straight across the stage, and CROSS: each
 * image's far edge lands on the opposite deck edge, 16' deep (the downstage strip), keystoned
 * square into an undistorted rectangle; the overlap in the middle is what follows (41.3'). Their
 * tilt, throw and keystone H are derived in layout.py (`side_rig`). Shift starts at 0; an upgrade keeps
 * whatever shift the session has since been given.
 *
 * The FLOOR (`deck` area) has its own material, so the projections read on it: a satin mid-grey
 * in the GLB, scaled by the Deck tone fader.
 *
 * And the SCRIM: the upstage curtain draws ADDITIVELY. An additive surface is still lit — it
 * catches the DS image and the work light — but it occludes nothing, blocks no projector
 * and writes no depth, so the light towers behind it show through where it is not lit
 * from the front, which is what a scrim does. (Light also carries on through it.) The kabuki is the same
 * material: the DS image lands on it while it is in and carries on to the scrim behind it. Both
 * take the Scrim fader's material (how much light they send back), and a depth-only render of
 * them (`drapeDepth`) tells the haze composite how far away they are, which their own additive
 * draw cannot.
 *
 * Everything downstream reads the projector nodes, so the beams in the haze, the shadow
 * cameras and the throws on the set all follow. The bodies are PARTS of the `rig` mesh
 * area (build.py tags them `loom_part`), and one point kernel turns and slides them with
 * the same numbers, so what you see hanging is what is throwing.
 *
 * `applyRig` is both halves: the generator calls it on a fresh session, and upgrade.ts calls
 * it on one you saved, keeping your fader values when the faders already exist.
 */

export const FT = 0.3048;
const DEG = 0.0174532925;

export interface Fader {
  readonly label: string;
  readonly caption: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** A side projector's aim as a pan line on the deck and a tilt down from level. */
interface SideAim {
  readonly pan: readonly [number, number];
  readonly drop: number;
  readonly restTilt: number;
  /** The projector's right vector at rest: the axis its tilt turns about. */
  readonly axis: Vec3;
  /** Its optical axis at rest: the axis its roll turns about. */
  readonly forward: Vec3;
}

function sideAim(projector: ProjectorFacts, deckTop: number): SideAim {
  const [ex, ey, ez] = projector.eye;
  const [lx, ly, lz] = projector.lookAt;
  const across = Math.hypot(lx - ex, lz - ez);
  const length = Math.hypot(lx - ex, ly - ey, lz - ez);
  const forward: Vec3 = [(lx - ex) / length, (ly - ey) / length, (lz - ez) / length];
  // right = forward × world up, as the projector's own basis builds it (camera.ts)
  const right: Vec3 = [-forward[2], 0, forward[0]];
  const norm = Math.hypot(right[0], right[2]);
  return {
    pan: [(lx - ex) / across, (lz - ez) / across],
    drop: ey - deckTop,
    restTilt: (Math.atan2(ey - ly, across) * 180) / Math.PI,
    axis: [right[0] / norm, 0, right[2] / norm],
    forward,
  };
}

const round = (value: number, step: number): number => Math.round(value / step) * step;

/**
 * Stage right's keystone H is this sign times the Side keystone H fader (stage left the
 * opposite): positive fader values narrow the far side of the crossed image, which is how
 * it squares up. Pinned by the footprint test in document.test.ts.
 */
const SIDE_KEY_SIGN = -1;

export function rigFaders(facts: StageFacts): Fader[] {
  const ds = facts.projectors.DS;
  const mount = requireMount(ds);
  const side = sideAim(facts.projectors.SR, facts.deckTop);
  return [
    { label: "dsThrow", caption: "DS throw ratio", value: ds.throwRatio, min: 0.3, max: 2.5, step: 0.01 },
    { label: "dsOffset", caption: "DS truss Z, ft", value: 0, min: -10, max: 40, step: 0.5 },
    { label: "dsTilt", caption: "DS tilt, ° down", value: round(mount.restTilt, 0.1), min: -20, max: 60, step: 0.1 },
    { label: "dsKeyV", caption: "DS keystone V, °", value: 0, min: -30, max: 30, step: 0.1 },
    { label: "dsKeyH", caption: "DS keystone H, °", value: 0, min: -30, max: 30, step: 0.1 },
    { label: "sideTilt", caption: "Side tilt, ° down", value: round(side.restTilt, 0.01), min: 10, max: 89, step: 0.01 },
    { label: "sideThrow", caption: "Side throw ratio", value: facts.projectors.SR.throwRatio, min: 0.5, max: 4, step: 0.01 },
    { label: "sideRoll", caption: "Side roll, °", value: 90, min: -180, max: 180, step: 1 },
    { label: "sideKeyV", caption: "Side keystone V, °", value: 0, min: -30, max: 30, step: 0.1 },
    { label: "sideKeyH", caption: "Side keystone H, °", value: round(facts.projectors.SR.keystoneH, 0.01), min: -45, max: 45, step: 0.01 },
    { label: "deckTone", caption: "Deck tone", value: 0.6, min: 0, max: 1, step: 0.01 },
    { label: "scrim", caption: "Scrim", value: SCRIM_DEFAULT, min: 0, max: 1, step: 0.01 },
    { label: "strobes", caption: "Strobe level", value: 0.5, min: 0, max: 1, step: 0.01 },
    { label: "orbit", caption: "Orbit, °", value: 0, min: -180, max: 180, step: 1 },
    { label: "zoom", caption: "Zoom, ft", value: 0, min: -80, max: 80, step: 0.5 },
  ];
}

function requireMount(ds: ProjectorFacts): NonNullable<ProjectorFacts["mount"]> {
  if (ds.mount === undefined) throw new Error("Stage GLB: proj.DS carries no mount (loom_pivot …); rebuild it with tools/blender/stage-previz/build.py.");
  return ds.mount;
}

/** The expressions each projector's pose and lens read: the faders, through the mount geometry. */
export function projectorSlots(facts: StageFacts): Record<ProjectorName, Slots> {
  const ds = facts.projectors.DS;
  const mount = requireMount(ds);
  const [px, py, pz] = mount.pivot;
  const t = `${chan("dsTilt")} * ${DEG}`;
  const off = `${chan("dsOffset")} * ${FT}`;
  // The lens rides the clamp: `forward` toward the scrim (−z) and `drop` below it, turned
  // down by the tilt. The aim is where that axis meets the scrim plane, so the projector's
  // nominal-brightness distance stays the throw.
  const eyeY = `${fmt(py)} - ${fmt(mount.drop)} * cos(${t}) - ${fmt(mount.forward)} * sin(${t})`;
  const eyeZ = `${fmt(pz)} + ${off} + ${fmt(mount.drop)} * sin(${t}) - ${fmt(mount.forward)} * cos(${t})`;
  const aimY = `${eyeY} - sin(${t}) / cos(${t}) * (${eyeZ} - (${fmt(mount.curtainZ)}))`;
  const slots: Partial<Record<ProjectorName, Slots>> = {
    DS: {
      ...vecSlots("eye", [fmt(px), eyeY, eyeZ], ds.eye),
      ...vecSlots("lookAt", [fmt(px), aimY, fmt(mount.curtainZ)], ds.lookAt),
      throwRatio: expressionSlot(chan("dsThrow"), ds.throwRatio),
      keystoneV: expressionSlot(chan("dsKeyV"), 0),
      keystoneH: expressionSlot(chan("dsKeyH"), 0),
    },
  };
  for (const name of ["SR", "SL"] as const) {
    const projector = facts.projectors[name];
    const aim = sideAim(projector, facts.deckTop);
    const tilt = `max(${chan("sideTilt")}, 5) * ${DEG}`;
    const across = `${fmt(aim.drop)} * cos(${tilt}) / sin(${tilt})`;
    slots[name] = {
      ...vecSlots("lookAt", [
        `${fmt(projector.eye[0])} + ${fmt(aim.pan[0])} * ${across}`,
        fmt(facts.deckTop),
        `${fmt(projector.eye[2])} + ${fmt(aim.pan[1])} * ${across}`,
      ], projector.lookAt),
      throwRatio: expressionSlot(chan("sideThrow"), projector.throwRatio),
      roll: expressionSlot(name === "SR" ? chan("sideRoll") : `-(${chan("sideRoll")})`, name === "SR" ? 90 : -90),
      shiftX: slotFromValue(0),
      shiftY: slotFromValue(0),
      // One fader for both, mirrored as the roll is: the mirror of a keystone H is its
      // negative (the image's long axis runs the other way across the stage); V is not mirrored.
      keystoneH: expressionSlot(name === "SR" ? `${SIDE_KEY_SIGN} * ${chan("sideKeyH")}` : `${-SIDE_KEY_SIGN} * ${chan("sideKeyH")}`, (name === "SR" ? SIDE_KEY_SIGN : -SIDE_KEY_SIGN) * projector.keystoneH),
      keystoneV: expressionSlot(chan("sideKeyV"), 0),
    };
  }
  return slots as Record<ProjectorName, Slots>;
}

const wgslVec = (v: Vec3): string => `vec3f(${v.map((c) => c.toFixed(5)).join(", ")})`;

/** The point kernel that turns and slides the bodies with the same numbers the projectors read. */
export function rigKernel(facts: StageFacts): string {
  const parts = facts.areas.rig.partTable;
  const part = (name: string): number => {
    const found = parts.get(name);
    if (found === undefined) throw new Error(`Stage GLB: the rig area has no part "${name}".`);
    return found.index;
  };
  const mount = requireMount(facts.projectors.DS);
  const sr = sideAim(facts.projectors.SR, facts.deckTop);
  const sl = sideAim(facts.projectors.SL, facts.deckTop);
  return `// Stage previz — the projector rig (generated by src/projects/stage-previz/rig.ts from the GLB's parts).
struct Params {
  dsOffset: f32, // @default 0  DS truss offset along z, metres (+ toward the house).
  dsTilt: f32, // @default ${fmt(mount.restTilt)}  DS projector tilt, degrees down, about its clamp.
  sideTilt: f32, // @default ${fmt(sr.restTilt)}  Side projectors' tilt, degrees down, about their lens.
  sideRoll: f32, // @default 90  Side projectors' roll, degrees (stage right +, stage left −): 90 is portrait.
};

const PART_DS_TRUSS: u32 = ${part("ds_truss")}u;
const PART_DS: u32 = ${part("proj_DS")}u;
const PART_SR: u32 = ${part("proj_SR")}u;
const PART_SL: u32 = ${part("proj_SL")}u;
const DS_PIVOT: vec3f = ${wgslVec(mount.pivot)};
const SR_LENS: vec3f = ${wgslVec(facts.projectors.SR.eye)};
const SL_LENS: vec3f = ${wgslVec(facts.projectors.SL.eye)};
const SR_AXIS: vec3f = ${wgslVec(sr.axis)};
const SL_AXIS: vec3f = ${wgslVec(sl.axis)};
const SR_FWD: vec3f = ${wgslVec(sr.forward)};
const SL_FWD: vec3f = ${wgslVec(sl.forward)};
const SIDE_REST: f32 = ${sr.restTilt.toFixed(5)};

// Rodrigues: v turned by angle about a unit axis.
fn turn(v: vec3f, axis: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  return v * c + cross(axis, v) * sin(angle) + axis * dot(axis, v) * (1.0 - c);
}

// Pitch down by t about +x, for the DS body built level and facing −z: (0,0,−1) → (0,−sin t,−cos t).
// rig.ts's projDS expressions turn the lens offset by exactly this.
fn pitch(v: vec3f, t: f32) -> vec3f {
  let c = cos(t);
  let s = sin(t);
  return vec3f(v.x, v.y * c + v.z * s, -v.y * s + v.z * c);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let part = u32(round(p.surface.w));
  if (part == PART_DS) {
    let t = radians(ctx.params.dsTilt);
    q.position = DS_PIVOT + pitch(p.position - DS_PIVOT, t);
    q.normal = pitch(p.normal, t);
  } else if (part == PART_SR || part == PART_SL) {
    let lens = select(SL_LENS, SR_LENS, part == PART_SR);
    let axis = select(SL_AXIS, SR_AXIS, part == PART_SR);
    let fwd = select(SL_FWD, SR_FWD, part == PART_SR);
    // The roll first, about the rest optical axis, by −roll — exactly how the Projector node
    // turns its own up vector (camera.ts guardedRolledUp) — so the body hangs as it throws.
    let roll = -radians(select(-ctx.params.sideRoll, ctx.params.sideRoll, part == PART_SR));
    // Then the tilt: turning about the right vector by +a lifts the nose, so down is −a.
    let down = -radians(max(ctx.params.sideTilt, 5.0) - SIDE_REST);
    q.position = lens + turn(turn(p.position - lens, fwd, roll), axis, down);
    q.normal = turn(turn(p.normal, fwd, roll), axis, down);
  }
  if (part == PART_DS || part == PART_DS_TRUSS) {
    q.position.z = q.position.z + ctx.params.dsOffset;
  }
  return q;
}`;
}

const RIG_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
  { name: "surface", type: "vec4f", default: [1, 0, 0, 0] },
]);

const FADER_ROW = -1250;
const RIG_POSITIONS = { mesh: [-4400, 2620], kernel: [-4100, 2940], geometry: [-3800, 2620] } as const;
const DECK_POSITIONS = { mesh: [-4400, 3260], material: [-4100, 3260], geometry: [-3800, 3260] } as const;
const DRAPE_POSITIONS = { material: [-4400, 3500], curtain: [-4100, 3500], kabuki: [-4100, 3700], depth: [-3800, 3600] } as const;
/** How much of the light falling on them the drapes send back: the Scrim fader's default. */
const SCRIM_DEFAULT = 0.35;
const DESK_ORDER = 100;

/**
 * Give a session the rig: the faders (your values kept when they exist), the moving bodies,
 * the projectors driven through them, and the parts of the session that read the GLB's
 * measured sizes and cameras brought up to date with it.
 */
export function applyRig(document: ProjectDocument, facts: StageFacts, options: { readonly reset?: readonly string[] } = {}): ProjectDocument {
  const nodes: Record<string, GraphNode> = { ...document.graph.nodes };
  const edges = { ...document.graph.edges };
  const put = (entry: GraphNode): void => {
    nodes[entry.id] = entry;
  };
  const faders = rigFaders(facts);
  faders.forEach((fader, index) => {
    const existing = nodes[fader.label];
    const kept = existing?.parameters["value"];
    const value = typeof kept === "number" && options.reset?.includes(fader.label) !== true ? kept : fader.value;
    const position = existing === undefined ? ([-4400 + index * 300, FADER_ROW] as const) : ([existing.position.x, existing.position.y] as const);
    put(node(fader.label, "slider", position, { channel: fader.label, caption: fader.caption, value, min: fader.min, max: fader.max, step: fader.step }, { label: fader.label }));
    const wire = edge(`e-${fader.label}-desk`, [fader.label, "out"], ["desk", "controls"], DESK_ORDER + index);
    edges[wire.id] = wire;
  });

  // The Panel: a Projectors section under whatever is on the board already.
  const desk = nodes["desk"];
  if (desk !== undefined) {
    const stored = typeof desk.parameters["board"] === "string" ? (desk.parameters["board"] as string) : "";
    const board = stored === "" ? { columns: 6, items: [] as Array<Record<string, unknown>> } : (JSON.parse(stored) as { columns: number; items: Array<Record<string, unknown>> });
    const ours = new Set<unknown>([...faders.map((fader) => fader.label)]);
    const items = board.items.filter((item) => !ours.has(item["member"]) && item["label"] !== "Projectors");
    // Orbit and Zoom get a row of their own under Source and Shot, the slider they move about.
    // The row is opened by pushing everything below it down one — unless it is already empty
    // (an upgrade of a session that has it), so running this twice lays the board out once.
    // A board laid out differently gets them beside Deck tone instead.
    const rectOf = (item: Record<string, unknown> | undefined) => item?.["rect"] as { x: number; y: number; w: number; h: number } | undefined;
    const shot = items.find((item) => item["member"] === "shot");
    const source = items.find((item) => item["member"] === "source");
    const shotRow = rectOf(shot)?.y;
    const viewRow = shotRow !== undefined && rectOf(source)?.y === shotRow ? shotRow + 1 : undefined;
    if (viewRow !== undefined) {
      source!["rect"] = { x: 0, y: shotRow!, w: 3, h: 1 };
      shot!["rect"] = { x: 3, y: shotRow!, w: 3, h: 1 };
      if (items.some((item) => rectOf(item)?.y === viewRow)) {
        for (const item of items) {
          const rect = rectOf(item);
          if (rect !== undefined && rect.y >= viewRow) item["rect"] = { ...rect, y: rect.y + 1 };
        }
      }
      items.push({ member: "orbit", rect: { x: 0, y: viewRow, w: 3, h: 1 } }, { member: "zoom", rect: { x: 3, y: viewRow, w: 3, h: 1 } });
    }
    const bottom = items.reduce((low, item) => {
      const rect = item["rect"] as { y: number; h: number } | undefined;
      return rect === undefined ? low : Math.max(low, rect.y + rect.h);
    }, 0);
    const at = (member: string, x: number, y: number, w: number) => ({ member, rect: { x, y: bottom + y, w, h: 1 } });
    items.push(
      { label: "Projectors", rect: { x: 0, y: bottom, w: 6, h: 1 } },
      at("dsThrow", 0, 1, 2), at("dsOffset", 2, 1, 2), at("dsTilt", 4, 1, 2),
      at("dsKeyV", 0, 2, 3), at("dsKeyH", 3, 2, 3),
      at("sideTilt", 0, 3, 2), at("sideThrow", 2, 3, 2), at("sideRoll", 4, 3, 2),
      at("sideKeyV", 0, 4, 3), at("sideKeyH", 3, 4, 3),
      at("deckTone", 0, 5, 2), at("scrim", 2, 5, 2), at("strobes", 4, 5, 2),
    );
    if (viewRow === undefined) items.push(at("orbit", 0, 6, 3), at("zoom", 3, 6, 3));
    put({ ...desk, parameters: { ...desk.parameters, board: serializePanelBoard({ columns: board.columns, items: items as never }) } });
  }

  // The moving bodies.
  const rig = facts.areas.rig;
  put(node("meshRig", "meshFileIn", RIG_POSITIONS.mesh, { file: facts.glbUrl, select: rig.select, vertices: rig.vertices, triangles: rig.triangles, parts: rig.parts }, { label: "meshRig" }));
  put(node("rigMotion", "pointKernel", RIG_POSITIONS.kernel, { capacity: rig.vertices, attributes: RIG_ATTRIBUTES, kernel: rigKernel(facts) }, {
    label: "rigMotion",
    parameters: {
      dsOffset: expressionSlot(`${chan("dsOffset")} * ${FT}`, 0),
      dsTilt: expressionSlot(chan("dsTilt"), requireMount(facts.projectors.DS).restTilt),
      sideTilt: expressionSlot(chan("sideTilt"), sideAim(facts.projectors.SR, facts.deckTop).restTilt),
      sideRoll: expressionSlot(chan("sideRoll"), 90),
    },
  }));
  put(node("geoRig", "geometry", RIG_POSITIONS.geometry, { mode: "surface", material: "matSurface" }, { label: "geoRig" }));
  for (const wire of [edge("e-meshRig-rigMotion", ["meshRig", "out"], ["rigMotion", "in"]), edge("e-rigMotion-geoRig", ["rigMotion", "out"], ["geoRig", "points"])]) {
    edges[wire.id] = wire;
  }
  // The floor: its own mesh, geometry and material, scaled by the Deck tone fader, drawn
  // wherever the stage is (the house view and each projector's own view of its occluders).
  const deck = facts.areas.deck;
  put(node("meshDeck", "meshFileIn", DECK_POSITIONS.mesh, { file: facts.glbUrl, select: deck.select, vertices: deck.vertices, triangles: deck.triangles }, { label: "meshDeck" }));
  put(node("matDeck", "materialPbr", DECK_POSITIONS.material, { metallic: 0, roughness: 0.6 }, { label: "matDeck", parameters: { color: expressionSlot(chan("deckTone"), 0.6) } }));
  put(node("geoDeck", "geometry", DECK_POSITIONS.geometry, { mode: "surface", material: "matDeck" }, { label: "geoDeck" }));
  const deckWire = edge("e-meshDeck-geoDeck", ["meshDeck", "out"], ["geoDeck", "points"]);
  edges[deckWire.id] = deckWire;
  for (const render of Object.values(nodes)) {
    if (render.type !== "render") continue;
    const scenes = String(render.parameters["scenes"] ?? "").split(/\s+/).filter(Boolean);
    if (scenes.includes("geoStage") && !scenes.includes("geoDeck")) put({ ...render, parameters: { ...render.parameters, scenes: [...scenes, "geoDeck"].join(" ") } });
  }

  // The scrim and the kabuki: lit, but additive — see the header — in their own material, the
  // Scrim fader: how much of the light falling on them they send back.
  put(node("matDrape", "materialPbr", DRAPE_POSITIONS.material, { metallic: 0, roughness: 0.5 }, { label: "matDrape", parameters: { color: expressionSlot(chan("scrim"), SCRIM_DEFAULT) } }));
  for (const id of ["geoCurtain", "geoKabuki"]) {
    const drape = nodes[id];
    if (drape !== undefined) put({ ...drape, parameters: { ...drape.parameters, blend: "additive", material: "matDrape" } });
  }
  // An additive surface writes no depth, so the haze composite used to fade the drapes' own
  // light by the distance to whatever is BEHIND them: through the top of the scrim that is the
  // empty house (80 m of haze — the scrim all but vanished), through its foot, seen from above,
  // the floor just past the deck (a few metres — the scrim stood out solid). The same meshes,
  // drawn opaque into a depth-only render from the view, give the composite the drapes' own
  // distance (haze.ts `drapeDistance`).
  const drapeSources: Array<[string, string, readonly [number, number]]> = [["geoCurtainDepth", "meshCurtain", DRAPE_POSITIONS.curtain], ["geoKabukiDepth", "kabukiFly", DRAPE_POSITIONS.kabuki]];
  const drapeDepths: string[] = [];
  for (const [id, source, position] of drapeSources) {
    if (nodes[source] === undefined) continue;
    put(node(id, "geometry", position, { mode: "surface", material: "matSurface" }, { label: id }));
    const wire = edge(`e-${source}-${id}`, [source, "out"], [id, "points"]);
    edges[wire.id] = wire;
    drapeDepths.push(id);
  }
  const atmosphereNode = nodes["atmosphere"];
  if (drapeDepths.length > 0 && atmosphereNode !== undefined) {
    put(node("drapeDepth", "render", DRAPE_POSITIONS.depth, {
      scenes: drapeDepths.join(" "), camera: "view", lights: "", ambientIntensity: 0, background: [0, 0, 0, 1], depthOutput: true,
    }, { label: "drapeDepth", resolution: { mode: "fixed", width: 960, height: 540 } }));
    const wire = edge("e-drapeDepth-atmosphere", ["drapeDepth", "depth"], ["atmosphere", "more"], 2);
    edges[wire.id] = wire;
  }
  const stage = nodes["stage"];
  if (stage !== undefined) {
    const scenes = String(stage.parameters["scenes"] ?? "").split(/\s+/).filter(Boolean);
    if (!scenes.includes("geoRig")) put({ ...stage, parameters: { ...stage.parameters, scenes: [...scenes, "geoRig"].join(" ") } });
  }

  // The projectors, driven through the rig, and the cameras that see what blocks them, wide
  // enough for their keystone.
  for (const [name, slots] of Object.entries(projectorSlots(facts)) as Array<[ProjectorName, Slots]>) {
    const shadowCam = nodes[`shadowCam${name}`];
    if (shadowCam !== undefined) put({ ...shadowCam, parameters: { ...shadowCam.parameters, fov: expressionSlot(shadowFovSource(`proj${name}`), 40) } });
    const projector = nodes[`proj${name}`];
    if (projector === undefined) continue;
    const rest = facts.projectors[name];
    // the lens's native aspect follows the export too (Barco UDX-4K40: 16:10)
    const statics: Record<string, ParameterValue> = { eye: [...rest.eye], lookAt: [...rest.lookAt], aspect: Math.round(rest.aspect * 10000) / 10000 };
    // Lens shift starts at 0 and is the user's after that: an upgrade keeps what the session has.
    const own = Object.fromEntries((["shiftX", "shiftY"] as const).filter((key) => projector.parameters[key] !== undefined).map((key) => [key, projector.parameters[key]!]));
    put({ ...projector, parameters: { ...projector.parameters, ...statics, ...slots, ...own } });
  }

  // What the GLB measured: mesh sizes, and the shots. A kernel fed by a mesh FOLLOWS the
  // mesh's measured vertex count by expression (VNB8): the app re-measures a GLB that changed
  // on disk and writes the new count onto the Mesh File In, and a capacity baked here would
  // then refuse the mesh and stop the whole document compiling.
  for (const entry of Object.values(nodes)) {
    if (entry.type !== "meshFileIn") continue;
    const area = Object.values(facts.areas).find((candidate) => candidate.select === entry.parameters["select"]);
    if (area === undefined) continue;
    put({ ...entry, parameters: { ...entry.parameters, vertices: area.vertices, triangles: area.triangles, ...(area.parts === "" ? {} : { parts: area.parts }) } });
    for (const wire of Object.values(edges)) {
      const kernel = nodes[wire.target.nodeId];
      if (wire.source.nodeId !== entry.id || kernel?.type !== "pointKernel") continue;
      put({ ...kernel, parameters: { ...kernel.parameters, capacity: expressionSlot(`op('${entry.label ?? entry.id}').par.vertices`, area.vertices) } });
    }
  }
  const view = nodes["view"];
  if (view !== undefined) put({ ...view, parameters: { ...view.parameters, ...viewSlots(facts) } });

  // The haze shaders this project generated travel inside the session as text, so a fix to
  // them (equi-angular sampling, say) only reaches a saved session here. Only a source that
  // still carries haze.ts's own "generated by" line is replaced; its parameters keep their values.
  const generated = (entry: GraphNode | undefined): entry is GraphNode =>
    entry !== undefined && String(entry.parameters["source"] ?? "").includes("generated by src/projects/stage-previz/haze.ts");
  for (const name of ["SR", "SL", "DS"] as const) {
    const beam = nodes[`beam${name}`];
    if (!generated(beam)) continue;
    const accumulates = Object.values(edges).some((wire) => wire.target.nodeId === beam.id && wire.target.portId === "more" && wire.order === 2);
    put({ ...beam, parameters: { ...beam.parameters, source: beamShader(name, accumulates) } });
  }
  const atmosphere = nodes["atmosphere"];
  if (generated(atmosphere)) put({ ...atmosphere, parameters: { ...atmosphere.parameters, source: compositeShader() } });

  // The pixel lines and strobes on one feed (fx.ts).
  applyFx(nodes, edges, facts);

  return { ...document, graph: { ...document.graph, nodes, edges } };
}
