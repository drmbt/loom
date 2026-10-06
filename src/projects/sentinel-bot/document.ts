import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../../examples/build-showcase-beat.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import { serializePresetBank } from "../../domain/presets/bank.ts";
import { CAMERA_DEFAULTS, CAMERA_STATEMENTS, CUT_DEFAULTS, SHOTS, cutStatements } from "./camera.ts";
import { FIELD, FIELD_ATTRIBUTES, FIELD_TOWERS, POD_CAPACITY, POD_COUNT, POD_KERNEL, POD_SURFACE_WGSL, TOWER_CAPACITY, TOWER_KERNEL, TOWER_SURFACE_WGSL } from "./field.ts";
import { PACK_BARS, fieldTurn, against, pace, packSize, phraseAttack, phraseDraw, phrasePause, phrasePerch, phraseSpiral, phraseSwim, rest, stride, surge } from "./director.ts";
import type { KitFacts, MeshSelectionFacts, Vec3 } from "./kit.ts";
import { CHAMBERS, PATH, chamberExpression, pathExpression } from "./path.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../furnace/post.ts";
import { DOF_WGSL, GTAO_WGSL, SSR_WGSL } from "../furnace/screen-space.ts";
import { FIELD_BERTH, swimLungeExpression, KIND, JOINT_ATTRIBUTES, PACK_WANDER, adriftAheadExpression, adriftExpression, ownCountOf, jointCount, jointKernel, type Pick } from "./rig.ts";
import { HULL_SURFACE_WGSL, hueExpression, lampParameter } from "./surface.ts";
import { BORE_ATTRIBUTES, BORE_COLUMNS, BORE_KERNEL, BORE_ROWS, BORE_SURFACE_WGSL, HAZE_WGSL, LAMPS_MIRRORED, LAMP_SPACING, MOTE_ATTRIBUTES, MOTE_COUNT, MOTE_KERNEL, lampHeightExpression, lampToneExpression } from "./tunnel.ts";
import { LAMP_ATTRIBUTES, LAMP_COUNT, LAMP_KERNEL } from "./tunnel.ts";

/**
 * T1561b — THE SENTINEL DOCUMENT: a robot walking, swimming and perching in the tunnel, played
 * from a panel and listening to a track.
 *
 * The data flows the way the finished piece keeps it. One number on the value graph says how
 * far the robot has come; the body and every joint are placed from it on the GPU; the camera
 * reads the same path on the CPU. The PANEL holds the piece's own words — Speed, Crawl, Swim,
 * Perch — and every one of them reaches a parameter as an ordinary expression, where the
 * track's lanes are mixed in.
 *
 * The tunnel is a lit surface inside the Render (tunnel.ts), with a lamp plate in its crown
 * every 12.8 m; the three lamps nearest the robot are real lights and fade in and out with
 * distance, so the set can change without a pop. Air and bloom follow.
 *
 * The robot is the kit's meshes instanced on the rig's points (§T1581b): a ring at every ring
 * joint, a hub and eight phalanges at every claw, the hull at each robot's own point.
 *
 * What is NOT here yet: three lamps are all a forward Render affords (§T1589b).
 */

/**
 * A track: where the app fetches it (a path under public/) and its tempo, which the piece
 * needs declared, because the camera cuts on its bars and the lights step on its beats.
 */
export interface SentinelTrack {
  readonly file: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  /** Seconds into the file where beat one falls. */
  readonly beatOffset: number;
}

/** The shipped beat: generated in code, so a headless render and a test hear exactly what the app plays. */
export const SHIPPED_TRACK: SentinelTrack = {
  file: SHOWCASE_BEAT_FILE,
  bpm: SHOWCASE_BEAT.bpm,
  beatsPerBar: SHOWCASE_BEAT.beatsPerBar,
  beatOffset: Math.round(SHOWCASE_BEAT_OFFSET_SECONDS * 1000) / 1000,
};

export interface SentinelDocumentOptions {
  readonly width?: number;
  readonly height?: number;
  /**
   * Each robot's place off the pack's own: right, up, ahead (metres). Default: the whole pack (PACK). The camera follows
   * the first. Every one of them is BUILT; how many are out is the panel's Pack and the track's say (the rig's `pack`),
   * and one that is not out costs nothing to draw: its points are rejected by Group and never reach a draw (§T1581b F1).
   */
  readonly robots?: readonly Vec3[];
  /**
   * What the frame may cost. `live` (the default) is what holds 60 frames a second in the app
   * and is what build.ts writes; `offline` spends what a render that is not watched live can.
   *
   * Measured in the app at 1280×720 with the kit's meshes instanced (one robot, documents
   * back to back, the control repeated):
   *   everything (two-phalanx fingers, the eyes' shadow, reflections)   41 to 44 fps
   *   no shadow-casting light                                           54 to 57 fps
   *   no shadow, and the claw one rigid piece instead of nine           60 fps   <- live
   *   no shadow, no reflections                                         60 fps
   *   the eyes' shadow kept, no reflections                             37 to 43 fps
   * A point light's shadow is six more sweeps of every piece, and each piece is a draw of its
   * own in each sweep; per-light caster lists and culled instances (§T1598b, §T1592b) are
   * what bring the shadow and the articulated claw back to the live tier.
   */
  readonly tier?: "live" | "offline";
  /** The track it plays to. Default: the shipped beat, which is what the committed project and the tests hear. */
  readonly track?: SentinelTrack;
  /**
   * The two things a tier decides, each on its own, for measuring one without the other. Unset, the tier decides.
   * `shadows`: whether EVERYTHING casts (the wall's ribs and pipes too). Off, the robot's body and tentacles
   * still cast, from the eyes' light and the lamp overhead.
   */
  readonly shadows?: boolean;
  readonly hingedClaws?: boolean;
  /**
   * Whether the tentacles are ROPES (§T1585b): each a strand a Rope simulates, held at its socket, by the way it
   * leaves the socket, and by its claw, with the rings and the claw drawn along what the Rope makes of it. Off,
   * they are the arcs the rig writes, drawn as written. Default: on, unless the claws are hinged (the hinged
   * claw's phalanges are placed by the rig's arithmetic, which does not know where a rope has gone).
   */
  readonly ropes?: boolean;
}

/**
 * A leader on the axis and two behind it, staggered: far enough apart that no two can reach
 * the same rung. The document's default is the leader alone, because that is what holds 60
 * frames a second today: measured in the app at 1280×720 with two shadow-casting lights, one
 * robot ran 55 to 59 fps and three 50 to 52. Each robot is a 152,490-vertex kernel and a
 * 213k-triangle hull drawn again in every cube-shadow sweep; an instanced hull with culling
 * (§T1581b, §T1592b) is what makes a pack cheap.
 */
export const PACK: readonly Vec3[] = [
  [0, 0, 0],
  // AN ECHELON, flown: the second up and well out to the leader's right, three metres back; the third down and
  // well out to its left, six back. As far to the side as the bore lets a body go, and far enough back that
  // no one's tentacles lie across another's body. Three formations before this did not read: a file down the
  // axis (the owner saw one robot), a tight wedge (the leader's own tail hid the third), and three abreast
  // ("wiggled into each other, overlapping … they need to space out a bit more to side and back"). In company
  // each also wanders far less and holds its tentacles' ends closer (rig.ts, PACK_WANDER). camera.ts's pack
  // shots are placed for exactly these numbers and its test projects them. A body this far off the axis cannot
  // reach the far wall, so a pack does not walk: while more than one is out, they all swim (constant_swim).
  // (The owner again, of 1.3 across and 0.45 up: "they could still spread out more horizontally and vertically,
  // still too tight on each other". These are as far out as a body goes inside the ribs with a hand to spare.)
  // And far enough back that no one's tentacles reach the next ("still not using the space and having tentacles
  // entangle"): a tentacle is 3.5 m, a robot's nose is 0.9 m ahead of its middle, so 5.5 m from one to the next.
  // In a hall the places across the tunnel grow with its radius (the rig's `roomy`): there they are 2.9 m out,
  // and the one above 1.7 m up. The one below stays 0.85 m under the axis: a hall's deck is no lower.
  [1.5, 0.9, -5.5],
  [-1.5, -0.85, -11],
];

/** Parameters may be slots (expressions, maps); the shared builder's signature takes values only. */
function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const map = (attribute: string, fallback: number | number[], channel?: string): StoredParameter => ({
  mode: "map",
  bindings: { static: { kind: "static", value: fallback }, map: { kind: "map", attribute, ...(channel === undefined ? {} : { channel }) } },
}) as StoredParameter;

interface Slider {
  readonly name: string;
  readonly caption: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

/** The panel's sliders. A slider is named after its channel, so `op('speed').chan.speed` reads the same word twice. */
const ROBOT: readonly Slider[] = [
  { name: "slider_speed", caption: "Speed", value: 3.2, min: 0, max: 9 },
  // Six of the ten on the wall: the rest trail, reach and feel about, and which six moves round the body (rig.ts).
  { name: "slider_crawl", caption: "Crawl", value: 0.6, min: 0, max: 1 },
  { name: "slider_swim", caption: "Swim", value: 0, min: 0, max: 1 },
  { name: "slider_stride", caption: "Stride", value: 3.2, min: 1.6, max: 4.4 },
  { name: "slider_flare", caption: "Flare", value: 0.25, min: 0, max: 1 },
  { name: "slider_wave", caption: "Wave", value: 0.05, min: 0, max: 0.3 },
  { name: "slider_grip", caption: "Grip", value: 1, min: 0, max: 1 },
  { name: "slider_gesture", caption: "Gesture", value: 0.6, min: 0, max: 1 },
  // Two moves of the repertoire, by hand; Follow the Track takes each a phrase at a time as well (director.ts).
  { name: "slider_spiral", caption: "Spiral (turns / 16 m)", value: 0, min: 0, max: 1.5 },
  { name: "slider_attack", caption: "Attack", value: 0, min: 0, max: 1 },
  // How many of the pack are out, at least: 1 is the leader alone. Follow the Track brings the others up when it is loud.
  { name: "slider_pack", caption: "Pack", value: 1, min: 1, max: PACK.length },
];
// The legs as ropes (rope_legs), in a document built with them: how much they weigh (metres a second squared: 9.8
// is a rope in air on Earth and 0 one adrift), how fast their swing dies (water is about 2), how firmly one that
// holds nothing is drawn after the shape the rig would have given it, and how far it swings its neck.
const ROPE_LEGS: readonly Slider[] = [
  { name: "slider_weight", caption: "Leg weight", value: 0, min: 0, max: 9.8 },
  { name: "slider_drag", caption: "Leg drag", value: 1.5, min: 0, max: 6 },
  { name: "slider_follow", caption: "Leg follow", value: 0.4, min: 0, max: 1 },
];
const SCENE: readonly Slider[] = [
  { name: "slider_bore", caption: "Tunnel", value: 2.6, min: 2.2, max: 3.4 },
  { name: "slider_lamp", caption: "Lamp", value: 26, min: 0, max: 80 },
  { name: "slider_distance", caption: "Camera distance", value: 7.5, min: -9, max: 12 },
  { name: "slider_react", caption: "Listen", value: 1, min: 0, max: 2 },
  { name: "slider_haze", caption: "Haze", value: 0.04, min: 0, max: 0.12 },
  { name: "slider_focus", caption: "Depth of field", value: 0.5, min: 0, max: 1.5 },
  // How far a kick opens the lens, in the phrases that it does (nearly half): 0 never.
  { name: "slider_pump", caption: "Focus on the kick", value: 0.6, min: 0, max: 2 },
  { name: "slider_grain", caption: "Grain", value: 0.06, min: 0, max: 0.2 },
  // The other place (field.ts): over a half, the tunnel is gone and the line runs through the fields.
  { name: "slider_fields", caption: "Fields", value: 0, min: 0, max: 1 },
];

// THE ROBOT'S LIGHTS, the piece's main instrument (surface.ts): the lenses of its face and the lines along its
// tentacles, in one colour range, each with its own ways of showing the track.
const LIGHTS: readonly Slider[] = [
  { name: "slider_huefrom", caption: "Colour from (hue)", value: 0, min: 0, max: 1 },
  // Past 1 is round the wheel again: From 0.9 To 1.1 crosses red.
  { name: "slider_hueto", caption: "Colour to (hue)", value: 0.03, min: 0, max: 1.5 },
  { name: "slider_spread", caption: "Colour spread", value: 0.6, min: 0, max: 1 },
  { name: "slider_hueshift", caption: "Colour follows level", value: 0.4, min: 0, max: 1 },
  { name: "slider_glow", caption: "Eyes", value: 9, min: 0, max: 30 },
  { name: "slider_eyehits", caption: "Eyes on drums", value: 0.6, min: 0, max: 1 },
  { name: "slider_eyesweep", caption: "Eye sweep (beat)", value: 0.25, min: 0, max: 1 },
  { name: "slider_legs", caption: "Leg lights", value: 1, min: 0, max: 3 },
  { name: "slider_meter", caption: "Leg meter (lows)", value: 0.7, min: 0, max: 1 },
  { name: "slider_chase", caption: "Leg chase (beat)", value: 0.3, min: 0, max: 2 },
  { name: "slider_spark", caption: "Leg spark (hats)", value: 0.6, min: 0, max: 2 },
];

/** A control's value. A widget is named kind_role (§T1593b) and publishes a channel named for the role alone: `speed` for `slider_speed`. */
const on = (name: string): string => `op('${name}').chan.${name.slice(name.indexOf("_") + 1)}`;
const LISTEN = on("slider_react");
const LOW = `(op('lag_levels').chan.low * ${LISTEN})`;
const HIGH = `(op('lag_levels').chan.high * ${LISTEN})`;
const KICK = `(op('lag_hits').chan.kickCount * ${LISTEN})`;
const HAT = `(op('lag_hits').chan.hatCount * ${LISTEN})`;
const SNARE = `(op('lag_hits').chan.snareCount * ${LISTEN})`;
const LEVEL = `(op('lag_levels').chan.level * ${LISTEN})`;
// The lights' colour range (surface.ts) and how far the level has moved them along it.
const HUE_SHIFT = `(${on("slider_hueshift")} * ${LEVEL})`;
/** The hue at a place (0 to 1) in the range: what the material's lightColour does, for a light. */
const hueAt = (place: number): string => `(${on("slider_huefrom")} + (${on("slider_hueto")} - ${on("slider_huefrom")}) * clamp(${place} * ${on("slider_spread")} + ${HUE_SHIFT}, 0, 1))`;
const TRAVEL = "op('speed_travel').chan.value";
const STROKE = "op('speed_stroke').chan.value";
// What the track is doing (director.ts), and whether the piece is following it.
const ENERGY = "op('constant_energy').chan.value";
const LIFT = "op('constant_lift').chan.value";
// The long view (director.ts): where this passage stands among the last minute's, and which bar the track is in.
const INTENSITY = "op('lag_intensity').chan.level";
const BAR = "op('audiofile_track').chan.bar";
// The moves, eased: how much it is attacking, and how tight a corkscrew it walks.
const ATTACK = "op('lag_attack').chan.value";
const SPIRAL = "op('lag_spiral').chan.value";
const FOLLOW = on("toggle_follow");
// Which place it is in: 0 the tunnel, 1 the fields (field.ts). The panel's Fields puts it there; following the
// track, the bar count does (director.ts, fieldTurn).
const placeAt = (bar: string): string => `max(${on("slider_fields")} > 0.5, ${fieldTurn(FOLLOW, bar)})`;
const PLACE = placeAt(BAR);
// …and whether it will be two bars from now: the pack is called up before the cut, so all of them are there when the walls go.
const PLACE_SOON = `max(${PLACE}, ${placeAt(`(${BAR} + 2)`)})`;
// How much it swims: one channel every piece's kernel reads (`lag_swim`, below).
const SWIM = "op('lag_swim').chan.value";

export function sentinelDocument(facts: KitFacts, options: SentinelDocumentOptions = {}): ProjectDocument {
  const travel = expressionSlot(TRAVEL, 0);
  const robots = options.robots ?? PACK;
  const offline = options.tier === "offline";
  const shadows = options.shadows ?? offline;
  const hingedClaws = options.hingedClaws ?? offline;
  const ropes = options.ropes ?? !hingedClaws;
  if (ropes && hingedClaws) throw new Error("sentinelDocument: hinged claws are placed by the rig's own arithmetic and cannot ride a Rope; build with ropes: false.");
  const track = options.track ?? SHIPPED_TRACK;
  // Perched, it eases to a stop (below) and its head scans the tunnel on two slow counts, so the sweep never repeats on the bar.
  const PERCHED = "op('lag_perched').chan.value";
  /**
   * WHEN IT STANDS STILL, IT AND THE PLACE ANSWER THE TRACK MORE (the owner, 2026-10-06: "rather have subject
   * and scene respond more if things become too static"). Perched or paused, nothing travels and the camera
   * holds: so the lamps take the kick as well as the low end, and the lenses and the legs' bands answer harder.
   */
  const LAMP_BREATH = `(0.7 + ${LOW} * 0.8 + 0.6 * ${KICK} * ${PERCHED})`;
  const STILL_GAIN = `(1 + 0.7 * ${PERCHED})`;
  const look: Record<string, StoredParameter> = {
    look: [0, 0],
    // It looks about as it goes, slowly, and now and then turns its head well round to one side for a second or
    // two; perched, it scans in earnest. (The owner, 2026-10-06: looking around "integrated into other moves".)
    "look.x": expressionSlot(`(0.14 + 0.45 * ${PERCHED}) * (0.7 * sin(abstime * 0.31) + 0.3 * sin(abstime * 0.83 + 1.2)) + 0.4 * smoothstep(0.8, 0.97, sin(abstime * 0.21 + 2)) * sin(abstime * 0.071 + 0.5)`, 0),
    "look.y": expressionSlot(`(0.05 + 0.2 * ${PERCHED}) * sin(abstime * 0.27 + 1)`, 0),
  };
  /** A point of the tunnel's centreline `ahead` metres from the robot, moved by (dx, dy): three expressions, and what a host with no value graph shows. */
  const onPath = (ahead: string, dx: string, dy: string, retained: readonly [number, number, number]): Record<"x" | "y" | "z", StoredParameter> => {
    const z = `(${TRAVEL} + ${ahead})`;
    const at = pathExpression(z);
    return { x: expressionSlot(`${at.x} + ${dx}`, retained[0]), y: expressionSlot(`${at.y} + ${dy}`, retained[1]), z: expressionSlot(z, retained[2]) };
  };
  // Where the camera rides is the rig's (camera.ts); a hand never holds a camera dead still.
  const RIG = (channel: string): string => `op('expression_camera').chan.${channel}`;
  // Where the robot has wandered to off the axis when nothing holds it (rig.ts): swimming, or in a hall.
  // (In company it wanders less than half as far: rig.ts, PACK_WANDER.)
  const COMPANY = "clamp(op('lag_pack').chan.value - 1, 0, 1)";
  const adrift = `(max(${SWIM}, ${chamberExpression(`(${TRAVEL} + 2.5)`)}) * (1 - ${(1 - PACK_WANDER).toFixed(2)} * ${COMPANY}))`;
  const wander = { x: `${adrift} * ${adriftExpression("x")}`, y: `${adrift} * ${adriftExpression("y")}` };
  // …and along it: the slow drift, and the lunge of each swimming stroke (rig.ts, robotZ).
  const lunge = `(${adrift} * (${adriftAheadExpression} + ${swimLungeExpression(STROKE, 0)}))`;
  // A close shot rides with it (the rig's `ride`), along the tunnel as well as across it: a long lens two metres
  // off a robot that had drifted a metre up the tunnel had it in a corner of the frame.
  const eye = onPath(`(${RIG("ahead")} + ${RIG("ride")} * ${lunge})`, `${RIG("right")} + ${RIG("ride")} * ${wander.x} + 0.02 * sin(abstime * 2.3)`, `${RIG("up")} + ${RIG("ride")} * ${wander.y} + 0.015 * sin(abstime * 1.7 + 1)`, [1.1, 0.6, -7.5]);
  // From behind it looks down the tunnel past the robot; from anywhere else at the robot, wherever it has wandered.
  const near = `(${RIG("aim")} < 1)`;
  const aim = onPath(`(${RIG("aim")} + ${near} * ${lunge})`, `${near} * ${wander.x}`, `${near} * ${wander.y}`, [0, 0, 3.3]);
  // The face's light hangs a hand's breadth in front of the foremost lens (the kit's own measure): clear of
  // the hull, which casts its shadow, and not out in the air ahead where its glow read as a ball the robot chased.
  const face = facts.eyes.length > 0 ? Math.max(...facts.eyes.map((lens) => lens.position[2])) + 0.2 : 0.65;
  // The face goes where the robot goes: off the axis and along it when it is adrift.
  // (Along it: the slow drift, and the lunge of each swimming stroke — rig.ts, robotZ.)
  const glow = onPath(`(${face.toFixed(3)} + ${lunge})`, wander.x, wander.y, [0, 0, face]);
  // The middle of the body, between the sockets: where the light of its own tentacles is.
  const core = onPath(`(-0.3 + ${lunge})`, wander.x, wander.y, [0, 0, -0.3]);
  /**
   * Where each follower of the pack is, and how far out (0 to 1), as expressions: what the rig does with `pack` for
   * the robot of that index (its place off the leader's, 45 m further back while it is on its way, wandering on its own count).
   */
  const followers = robots.slice(1).map((offset, index) => {
    const present = `clamp(op('lag_pack').chan.value - ${index + 1}, 0, 1)`;
    const out = `(${present} * ${present} * (3 - 2 * ${present}))`;
    const own = ownCountOf(offset);
    // Its place across the tunnel grows with the room there is (rig.ts, `roomy`): sideways and upward in a
    // hall, and only with the bore itself downward, where a hall's deck is no lower.
    // Out in the fields there is all the room there is, below as well as above (rig.ts, FIELD_BERTH).
    const wide = `(${on("slider_bore")} / 2.6)`;
    const roomy = `(${wide} * (1 + ${CHAMBERS.swell} * max(${chamberExpression(`(${TRAVEL} + ${offset[2]})`)}, ${FIELD_BERTH} * ${PLACE})))`;
    return {
      out,
      at: onPath(`(${offset[2]} - 0.3 - 45 * (1 - ${out}) + ${adrift} * ${swimLungeExpression(STROKE, index + 1)})`, `${offset[0]} * ${roomy} + ${adrift} * ${adriftExpression("x", own)}`, `${offset[1]} * ${offset[1] > 0 ? roomy : `max(${wide}, ${roomy} * ${PLACE})`} + ${adrift} * ${adriftExpression("y", own)}`, [offset[0], offset[1], offset[2]]),
    };
  });
  /** The lamp station `step` stations from the one the robot is under: where it hangs, and how much of it is lit (1 within half a spacing, 0 a spacing and a half away, so the three in use trade places unseen). */
  const lampAt = (step: number): { position: Record<"x" | "y" | "z", StoredParameter>; near: string; high: string; tone: readonly [string, string, string] } => {
    const station = `(floor(${TRAVEL} / ${LAMP_SPACING}) + ${step})`;
    const z = `((floor(${TRAVEL} / ${LAMP_SPACING}) + ${step + 0.5}) * ${LAMP_SPACING})`;
    const at = pathExpression(z);
    const rest = (step + 0.5) * LAMP_SPACING;
    return {
      position: { x: expressionSlot(at.x, 0), y: expressionSlot(lampHeightExpression(z, on("slider_bore")), 2.25), z: expressionSlot(z, rest) },
      near: `clamp(1.5 - abs(${z} - ${TRAVEL}) / ${LAMP_SPACING}, 0, 1)`,
      // A hall's lamp hangs higher and is the bigger lamp for it, by how much higher. Not by the square, which
      // would light the deck under it as a plain bore's is: tried, and the hall was a lit room, every wall of it.
      // A hall is a bigger dark with the same few lamps (the owner: "it shouldn't look like a hospital").
      high: `(1 + ${CHAMBERS.swell} * ${chamberExpression(z)})`,
      // The light is the colour of the plate it hangs under (tunnel.ts, LAMP_TONES).
      tone: lampToneExpression(station),
    };
  };
  /** What every screen-space pass needs of the camera to turn a pixel back into a ray: read off the camera node itself. */
  const lens: Record<string, StoredParameter> = {
    eye: [1.1, 0.6, -7.5],
    aim: [0, 0, 3.3],
    ...Object.fromEntries((["x", "y", "z"] as const).flatMap((axis) => [[`eye.${axis}`, expressionSlot(`op('camera_rig').par.eye.${axis}`, 0)], [`aim.${axis}`, expressionSlot(`op('camera_rig').par.lookAt.${axis}`, 0)]])),
    fov: expressionSlot("op('camera_rig').par.fov", 55),
    far: 240,
    roll: 0,
  };
  const lamps = [-1, 0, 1].map(lampAt);
  /** The lamps that are Lights of their own: the three nearest, and only where their shadows are drawn. */
  const namedLamps = shadows ? lamps : [];
  /**
   * WHAT THE ROBOT THROWS ON THE TUNNEL IS WHAT ITS LIGHTS ARE DOING (the owner, 2026-10-05: the light on
   * the environment was "always … red", whatever the face was doing). The face: a third of the lenses each
   * answer kick, snare and hat (surface.ts), and a lens's place in the colour range is the same number that
   * puts it in a third, so the three thirds sit at a sixth, a half and five sixths of the range. The light is
   * their sum: its colour is the lit thirds' colours weighed by how bright each is now, its strength their mean.
   */
  const struck = (drum: string): string => `(1 + ${on("slider_eyehits")} * (2.6 * ${drum} - 0.75))`;
  const thirds = [{ lit: struck(KICK), tone: hueExpression(hueAt(1 / 6)) }, { lit: struck(SNARE), tone: hueExpression(hueAt(0.5)) }, { lit: struck(HAT), tone: hueExpression(hueAt(5 / 6)) }];
  const faceLit = `(${thirds.map((third) => third.lit).join(" + ")})`;
  const eyeTone = ([0, 1, 2] as const).map((channel) => `((${thirds.map((third) => `${third.lit} * ${third.tone[channel]}`).join(" + ")}) / max(${faceLit}, 0.001))`) as [string, string, string];
  /** How bright the face is now against its steady glow: 1 with Eyes on Drums at 0. */
  const faceLevel = `(${faceLit} / 3)`;
  /** The legs' light: a tentacle's colours run the whole range, so it throws the range's two halves mixed; brighter with the lows (the meter) and on a kick (the pulse). */
  const legTone = ([0, 1, 2] as const).map((channel) => `((${hueExpression(hueAt(0.25))[channel]} + ${hueExpression(hueAt(0.75))[channel]}) / 2)`) as [string, string, string];
  const legLevel = `(${on("slider_legs")} * (0.5 + 2.4 * ${on("slider_meter")} * ${LOW} + 1.6 * ${KICK}))`;
  /** The lamps the robot's steel can show a reflection of (surface.ts). */
  const mirrored = Array.from({ length: LAMPS_MIRRORED * 2 + 1 }, (_, index) => lampAt(index - LAMPS_MIRRORED));
  /** What the fields' materials read: the pods are the robots' lights' kin, in the same colour range, and answer the track. */
  const fieldLight: Record<string, StoredParameter> = {
    glow: expressionSlot(`${on("slider_glow")} * 0.27`, 2.4),
    hueFrom: expressionSlot(on("slider_huefrom"), 0),
    hueTo: expressionSlot(on("slider_hueto"), 0.03),
    low: expressionSlot(LOW, 0),
    kick: expressionSlot(KICK, 0),
    react: expressionSlot(on("slider_react"), 1),
  };
  const swimming: Record<string, StoredParameter> = { swim: expressionSlot(SWIM, 0), stroke: expressionSlot(STROKE, 0) };
  /**
   * The robot's pieces: each a mesh from the kit, and the points of the rig it is drawn on.
   * The kit holds every piece at the origin in its own joint frame (the hull in the robot's),
   * so the file's world IS the shape's frame and Frame stays at World. Each piece has a
   * kernel of its own writing exactly its points (rig.ts, Pick), so a draw takes every point
   * it is handed and needs no Group. Only the rings do: the rig stows the first of them in
   * the body (kind −1) while a tentacle has slack, and a stowed ring is in no draw.
   *
   * A Group is not free where it rejects nothing (§T1581b F1, 091bebe2): a geometry with one
   * compacts its instances and draws indirect in every pass, about 0.05 ms of GPU a pass
   * more than a literal count. Measured by the lead on these documents, shadows on: the
   * hinged robot 18.5 ms with a Group on all eleven draws, 11.1 ms with none.
   */
  /**
   * `rides`: with ropes, where a piece's points come from instead of a kernel of its own. The rings' kernel
   * writes the STRANDS (a tentacle's rings in order, the last of them the wrist), a Rope simulates them and
   * Curve Frames gives each point the frame a ring is drawn in: `strand` is that chain's own piece and `wrist`
   * a piece drawn on the chain's last points (its Group picks them by kind).
   */
  const pieces: ReadonlyArray<{ readonly role: string; readonly shape: MeshSelectionFacts; readonly pick: Pick; readonly stows?: boolean; readonly rides?: "strand" | "wrist" }> = [
    { role: "hull", shape: facts.robot, pick: "body" },
    { role: "ring", shape: facts.ring, pick: { first: 0, count: facts.ringCount }, stows: true, ...(ropes ? { rides: "strand" as const } : {}) },
    // The claw: live, one rigid piece on the wrist; offline, its cone and eight phalanges, each hinged (see `tier`).
    ...(hingedClaws
      ? [{ role: "hub", shape: facts.hub, pick: { first: facts.ringCount, count: 1 } }, ...facts.phalanxMeshes.map((shape, which) => ({ role: `phalanx${which}`, shape, pick: { first: facts.ringCount + 1 + which, count: 1 } }))]
      : [{ role: "claw", shape: facts.claw, pick: { first: facts.ringCount, count: 1 }, ...(ropes ? { rides: "wrist" as const } : {}) }]),
  ];
  /** The node a piece's draw takes its points from. */
  const pointsOf = (piece: (typeof pieces)[number]): string => (piece.rides === undefined ? `kernel_${piece.role}` : "frames_legs");
  /**
   * WHICH LIGHTS CAST, live: ONE of the five, the body's own (its tentacles' shadows on the bore round it,
   * lamp or no lamp). A point light's shadow is six faces of every caster, and the robot is 645,000 triangles
   * with nothing to cull it by, so each casting light costs 1.2 to 1.6 ms of GPU here (the lead, §T1604b).
   * Measured in the app at 1280×720 on a machine other sessions were loading, documents back to back, twice:
   *   five casting, 4x multisampled        26 to 30 frames a second
   *   two casting, 4x multisampled         34 to 42
   *   two casting, not multisampled        45 to 54
   *   ONE casting, not multisampled        52 to 58   <- live
   *   none casting, no focus, not multisampled   55 to 60 (the same machine's ceiling that hour)
   * The lamps' shadows (the robot on the deck under a lit lamp) and the eyes' are offline's, until the robot
   * is fewer triangles or a shadow can cull.
   *
   * Which geometries a light's shadow is cast by. Live, the robot's body and tentacles only, by
   * name (§T1598b: a Light's Shadow Casters; measured by the lead on this document at 0.3 ms a
   * frame for the eyes' light, against 4 to 6 ms with everything casting). Offline, everything:
   * the ribs and pipes shadow the wall too. The owner noticed its absence: "shadow seems to not
   * really working for the robot on the environment".
   */
  const robotCasts: Record<string, StoredParameter> = shadows ? {} : { shadowCasters: `geometry_hull geometry_ring ${hingedClaws ? "geometry_hub" : "geometry_claw"}` };
  const pieceNodes = (rig: Record<string, StoredParameter>): GraphNode[] =>
    pieces.flatMap((piece, index) => [
      node(`mesh_${piece.role}`, "meshFileIn", [-2700, index * 150], { file: facts.glbUrl, select: piece.shape.select, vertices: piece.shape.vertices, triangles: piece.shape.triangles, parts: piece.shape.parts }, { label: `mesh_${piece.role}` }),
      // A piece drawn on the strands' wrists has no points of its own.
      ...(piece.rides === "wrist" ? [] : [node(`kernel_${piece.role}`, "pointKernel", [-2400, index * 150], { capacity: jointCount(facts, piece.pick) * robots.length, attributes: JOINT_ATTRIBUTES, kernel: jointKernel(facts, robots, piece.pick, { rope: piece.rides === "strand" }), ...rig }, { label: `kernel_${piece.role}` })]),
      node(`geometry_${piece.role}`, "geometry", [-1800, index * 150], {
        mode: "instances",
        shape: "mesh",
        material: "material_hull",
        orient: map("orient", [0, 0, 0, 1]),
        // Not drawn: a ring still stowed in the body, and every piece of a robot of the pack that is not out. With one
        // robot built there is nothing of the second kind, and only the rings need the Group (a Group that rejects
        // nothing costs an indirect draw a pass for nothing).
        // On a rope the last ring of a tentacle is its wrist as well: the claw is drawn there and nowhere else.
        ...(piece.rides === "wrist" ? { group: `abs(p.kind - ${KIND.hub}.0) < 0.5` } : piece.stows === true || robots.length > 1 ? { group: "p.kind > -0.5" } : {}),
      }, { label: `geometry_${piece.role}` }),
    ]);
  /**
   * THE LEGS AS ROPES (the owner, three times: "very stiff and not floppy ropey", "not squiddly draggy enough",
   * and a friend who animates, "leg movement can use more work and looks jank still"). The rig still says
   * where a tentacle leaves the body, where its claw is and how firmly it holds; what the length between
   * does is now a rope's: it lags what drags it, swings on, and settles.
   *
   *   Anchor First, Anchor Second   the socket and the next ring out: the tentacle leaves the way the socket faces.
   *   Anchor Last                   the claw, by the strand's own weight (`hold`): 1 on a rung, 0 when it holds nothing.
   *   Pin Attribute                 every ring (`pin`): 1 on a tentacle that holds the wall, Follow on one that does not.
   *   Update Rate 240, at least 2 steps a frame   what the Rope's own measurements ask for a claw thrown at 8 m/s.
   *   Teleport 100 m, Carry         the lap's end moves every strand whole, shape and speed kept.
   *
   * The panel's Rope Legs turns it ON: until then the Rope holds every strand on the rig's own points (Reset).
   * It ships off, because what it does is motion and nobody has watched it yet: the measurements say a swimming
   * tentacle is clean (8 degrees between rings at the sharpest, 7 to 17 cm behind its shape) and a walking one that
   * holds nothing is too (31 degrees), and that a tentacle kinks at the socket for the few frames in which it is
   * handed back to the rig as it takes the wall (59 degrees).
   * So today the rope is the tentacles that hold NOTHING: trailing, swimming, feeling about. Each ring of one is
   * drawn toward the shape the rig gives it (the rig's Follow, by the Rope's Pin Attribute), its last rings free.
   * One on a rung is the rig's own arc and waits for the Rope's bend limit and winch (§T1585b): held at both
   * ends with its slack out and nothing to stop it bending, a strand folds flat on itself (legs.gpu.test.ts).
   */
  const legNodes: GraphNode[] = ropes
    ? [
        node("topology_legs", "pointTopology", [-2250, 300], { connectivity: "strips", cols: facts.ringCount, rows: facts.sockets.length * robots.length }, { label: "topology_legs" }),
        node("rope_legs", "pointRope", [-2100, 300], {
          updateRate: 240,
          minSteps: 2,
          maxSteps: 8,
          iterations: 8,
          gravity: expressionSlot(on("slider_weight"), 0),
          damping: expressionSlot(on("slider_drag"), 1.5),
          segmentLength: facts.ringPitch,
          anchorFirst: 1,
          anchorSecond: 1,
          anchorLast: map("hold", 0),
          pinAttribute: "pin",
          anchorMode: "hard",
          teleportDistance: 100,
          teleportMode: "carry",
          reset: expressionSlot(`1 - ${on("toggle_ropes")}`, 0),
        }, { label: "rope_legs" }),
        // Each ring's frame from the strand as it now lies, started from the socket's own (the rig's `orient` there).
        node("frames_legs", "pointCurveFrames", [-1950, 300], { method: "minimiseTwist", seed: "orient", seedOrient: "orient" }, { label: "frames_legs" }),
      ]
    : [];

  // The Robot panel: with rope legs, their four controls and the switch that turns the rope off.
  const robotSliders = ropes ? [...ROBOT, ...ROPE_LEGS] : ROBOT;
  const robotToggles = ["toggle_perch", "toggle_follow", ...(ropes ? ["toggle_ropes"] : [])];
  const sliders = [...robotSliders, ...SCENE, ...LIGHTS];
  const controls: GraphNode[] = [
    ...sliders.map((slider, index) => node(slider.name, "slider", [-3600 + (index % 4) * 300, 1500 + Math.floor(index / 4) * 250], { channel: slider.name.slice(slider.name.indexOf("_") + 1), caption: slider.caption, value: slider.value, min: slider.min, max: slider.max, step: 0 }, { label: slider.name })),
    node("toggle_perch", "toggle", [-3600, 3500], { channel: "perch", caption: "Perch", on: false }, { label: "toggle_perch" }),
    node("xypad_view", "xyPad", [-3300, 3500], { channel: "view", caption: "Chase side / height", x: 1.1, y: 0.6, min: -2, max: 2 }, { label: "xypad_view" }),
    node("slider_shot", "slider", [-3000, 3500], { channel: "shot", caption: `Shot (0 to ${SHOTS.length - 1})`, value: 0, min: 0, max: SHOTS.length - 1, step: 1 }, { label: "slider_shot" }),
    node("toggle_cuts", "toggle", [-2700, 3500], { channel: "cuts", caption: "Cut on the bars", on: true }, { label: "toggle_cuts" }),
    node("toggle_follow", "toggle", [-3600, 3750], { channel: "follow", caption: "Follow the track", on: true }, { label: "toggle_follow" }),
    ...(ropes ? [node("toggle_ropes", "toggle", [-3300, 3750], { channel: "ropes", caption: "Rope legs", on: false }, { label: "toggle_ropes" })] : []),
  ];
  /**
   * THREE PANELS, not one board: the phone draws a tab for each (§T1517b), and a board taller than
   * the screen cannot be scrolled there without moving the sliders under the finger (§T1607b, the
   * owner 2026-10-05). Each board is a few columns across and a row of it is as tall as a column is
   * wide, so the column count below is how tall a control is on a phone and on the desk alike.
   */
  // Each is published to the phone (Phone: on). That opens nothing by itself: a phone reaches them only through
  // the helper's phone door, armed by its own flag and opened from the paired tab.
  // Nine columns: a row of a board is as tall as a column is wide, so more columns is a lower slider. They
  // were eight; the owner, 2026-10-06: "the sliders for the controls could be a tiny bit less high on both app
  // pane and on mobile. just a smidge too chunky". I made them ten without looking at a phone, and at 375 px a
  // row was 30 px: "on the phone the sliders are now crunched and some buttons cut off … we may have went
  // overboard". Nine is a ninth lower than eight, 34 px on that phone, looked at there before it shipped.
  const COLUMNS = 9;
  // A control takes eight of the nine: the last column of every panel is bare board, so on a phone there is
  // somewhere to put a thumb and scroll that is not a slider. (The owner, 2026-10-06, after the phone's own
  // scrolling had landed: "still pretty hard to not screw with the sliders when scrolling on mobile".)
  const row = (member: string, y: number): { member: string; rect: { x: number; y: number; w: number; h: number } } => ({ member, rect: { x: 0, y, w: COLUMNS - 1, h: 1 } });
  const heading = (label: string, y: number): { label: string; rect: { x: number; y: number; w: number; h: number } } => ({ label, rect: { x: 0, y, w: COLUMNS, h: 1 } });
  /**
   * BACK TO WHAT WAS SAVED (the owner, 2026-10-06: "ways to reset controls individually or all according to
   * what was saved … accessible on both phone and browser"). Each panel carries a bank of one preset, `saved`:
   * every control of that panel at the value this file ships it with. One press on the desk or on the phone
   * puts that panel back. (One control at a time is the engine's to add; the lead has the row.)
   */
  const slidersSaved = (list: readonly Slider[]): Record<string, Record<string, number | boolean>> => Object.fromEntries(list.map((slider) => [slider.name, { value: slider.value }]));
  const saved: ReadonlyArray<Record<string, Record<string, number | boolean>>> = [
    { ...slidersSaved(robotSliders), toggle_perch: { on: false }, toggle_follow: { on: true }, ...(ropes ? { toggle_ropes: { on: false } } : {}) },
    { ...slidersSaved(SCENE), slider_shot: { value: 0 }, toggle_cuts: { on: true }, xypad_view: { x: 1.1, y: 0.6 } },
    slidersSaved(LIGHTS),
  ];
  const bankOf = (panel: string): string => `presets_${panel}`;
  /**
   * A bank shows on a board as a strip of buttons, one a preset, named as the preset is (and a Store after
   * them). So the preset is named for what pressing it does: `reset_robot`, `reset_scene`, `reset_lights`,
   * and `reset_all` for every control of the piece. (They were each called `saved`, and the owner, with the
   * button in front of him: "resetting in the controls is not visible for me anywhere … I have to reload
   * right now if I screw something up. want to be able to reset individual controls or all page or all".
   * The page and all are these; one control at a time is the engine's, §T1619b.)
   */
  const resetOf = (panel: string): string => `reset_${panel}`;
  // What each panel's board holds, top row down: its heading, its own reset, its controls.
  const boards = {
    robot: [heading("Robot", 0), row(bankOf("robot"), 1), ...robotSliders.map((slider, index) => row(slider.name, 2 + index)), ...robotToggles.map((toggle, index) => row(toggle, 2 + robotSliders.length + index))],
    scene: [
      heading("Scene", 0),
      row(bankOf("scene"), 1),
      ...SCENE.map((slider, index) => row(slider.name, 2 + index)),
      heading("Camera", 2 + SCENE.length),
      row("slider_shot", 3 + SCENE.length),
      row("toggle_cuts", 4 + SCENE.length),
      { member: "xypad_view", rect: { x: 1, y: 5 + SCENE.length, w: 6, h: 6 } },
    ],
    lights: [heading("Lights", 0), row(bankOf("lights"), 1), ...LIGHTS.map((slider, index) => row(slider.name, 2 + index))],
  };
  const rowsOf = (board: ReadonlyArray<{ rect: { y: number; h: number } }>): number => Math.max(...board.map((item) => item.rect.y + item.rect.h));
  const members = {
    robot: [...robotSliders.map((slider) => slider.name), ...robotToggles],
    scene: [...SCENE.map((slider) => slider.name), "slider_shot", "toggle_cuts", "xypad_view"],
    lights: LIGHTS.map((slider) => slider.name),
  };
  // Each of the three has the reset for everything right under its own, so a phone has both on whichever panel
  // is up, in the same place on each: the heading, the panel's reset, the reset for everything, then the controls.
  const withResetAll = (board: ReadonlyArray<{ rect: { x: number; y: number; w: number; h: number } }>): Array<Record<string, unknown>> => [
    ...board.filter((item) => item.rect.y < 2),
    row(bankOf("all"), 2),
    ...board.filter((item) => item.rect.y >= 2).map((item) => ({ ...item, rect: { ...item.rect, y: item.rect.y + 1 } })),
  ];
  const panels: ReadonlyArray<{ id: string; title: string; members: readonly string[]; board: string }> = (["robot", "scene", "lights"] as const).map((panel) => ({
    id: `panel_${panel}`,
    title: panel.charAt(0).toUpperCase() + panel.slice(1),
    members: members[panel],
    board: serializePanelBoard({ columns: COLUMNS, items: withResetAll(boards[panel]) as never }),
  }));
  /**
   * ALL OF THEM AT ONCE, for the desk (the owner, 2026-10-06: "an 'All' tab where we see all of them at once …
   * and where there is space definitely 2 columns"). The same controls and the same resets as the three
   * panels, laid out in two columns of eight under the reset for everything: the robot's on the left, the
   * scene's and the lights' on the right. Not published to the phone: a control half a phone wide is one a
   * thumb cannot hold. (A board that takes one column or two by the width it is given is the engine's to
   * make; this one is two.)
   */
  const shifted = (board: ReadonlyArray<{ rect: { x: number; y: number; w: number; h: number } }>, dx: number, dy: number): Array<Record<string, unknown>> =>
    board.map((item) => ({ ...item, rect: { ...item.rect, x: item.rect.x + dx, y: item.rect.y + dy } }));
  const everything = {
    id: "panel_all",
    title: "All",
    members: panels.flatMap((panel) => panel.members),
    board: serializePanelBoard({
      columns: COLUMNS * 2,
      items: [{ member: bankOf("all"), rect: { x: 0, y: 0, w: COLUMNS * 2 - 1, h: 1 } }, ...shifted(boards.robot, 0, 1), ...shifted(boards.scene, COLUMNS, 1), ...shifted(boards.lights, COLUMNS, 1 + rowsOf(boards.scene))] as never,
    }),
  };
  const targetsOf = (values: Record<string, Record<string, number | boolean>>): string => Object.entries(values).flatMap(([name, held]) => Object.keys(held).map((key) => `${name}.${key}`)).join(" ");
  const savedAll: Record<string, Record<string, number | boolean>> = Object.assign({}, ...saved);
  const banks: GraphNode[] = [
    ...["robot", "scene", "lights"].map((panel, index) =>
      node(bankOf(panel), "presets", [-2400 + index * 300, 3750], { targets: targetsOf(saved[index] ?? {}), presets: serializePresetBank({ version: 1, presets: [{ name: resetOf(panel), values: saved[index] ?? {} }] }) }, { label: bankOf(panel) }),
    ),
    node(bankOf("all"), "presets", [-1500, 3750], { targets: targetsOf(savedAll), presets: serializePresetBank({ version: 1, presets: [{ name: resetOf("all"), values: savedAll }] }) }, { label: bankOf("all") }),
  ];

  // Every control is on exactly one panel: one left off would be a slider nobody can reach from a phone.
  const placed = panels.flatMap((panel) => panel.members);
  const unplaced = controls.map((control) => control.id).filter((id) => !placed.includes(id));
  if (unplaced.length > 0 || new Set(placed).size !== placed.length) throw new Error(`sentinel-bot: every control goes on exactly one panel; not placed: ${unplaced.join(", ") || "none"}; placed ${placed.length} of ${controls.length}.`);

  const nodes: GraphNode[] = [
    // ── The track, and the lanes the piece listens to ──
    node("audiofile_track", "audioFileIn", [-3600, 600], {
      file: track.file, playMode: "timeline", play: true, speed: 1, cue: false, cuePoint: 0,
      trimStart: 0, trimEnd: 0, extend: "loop", volume: 1, monitor: true,
      tempoMode: "declared", bpm: track.bpm, beatsPerBar: track.beatsPerBar,
      beatOffset: track.beatOffset,
    }, { label: "audiofile_track" }),
    node("select_levels", "valueSelect", [-3300, 500], { channels: "level low high" }, { label: "select_levels" }),
    node("lag_smooth", "valueLag", [-3000, 500], { lag: 0.02, releaseRatio: 4 }, { label: "lag_smooth" }),
    node("normalize_levels", "valueNormalize", [-2700, 500], { window: 16 }, { label: "normalize_levels" }),
    // Fast attack, slow release: a level that rises late reads as the picture lagging the music.
    node("lag_levels", "valueLag", [-2400, 500], { lag: 0.03, releaseRatio: 5 }, { label: "lag_levels" }),
    node("select_hits", "valueSelect", [-3300, 750], { channels: "kickCount snareCount hatCount" }, { label: "select_hits" }),
    node("lag_hits", "valueLag", [-3000, 750], { lag: 0.001, releaseRatio: 250 }, { label: "lag_hits" }),
    // How busy the track is, for the camera's cuts (camera.ts, CUT_PACE): kicks and snares a second over the last
    // four, up within a second of a beat coming in and down over six after it goes, so a bar's rest does not slow the cutting.
    node("rate_hits", "valueRate", [-3300, 450], { window: 4 }, { label: "rate_hits" }),
    node("expression_busy", "valueExpression", [-3000, 450], { expressions: "busy = kickCount + snareCount", defaults: "kickCount = 0;\nsnareCount = 0" }, { label: "expression_busy" }),
    node("select_busy", "valueSelect", [-2700, 450], { channels: "busy" }, { label: "select_busy" }),
    node("lag_busy", "valueLag", [-2400, 450], { lag: 1, releaseRatio: 6 }, { label: "lag_busy" }),
    // THE CUTS (camera.ts, cutStatements): a request for one on every eighth, fourth or second bar line by how busy
    // the track is, and a Count that grants it unless the last cut was less than a shot's length ago. The camera
    // reads the count: it is the number of the shot.
    // (The bar alone from the track: an Expression's wires share one bag, and the track has a `level` of its own.)
    node("select_bar", "valueSelect", [-2400, 300], { channels: "bar" }, { label: "select_bar" }),
    node("expression_cut", "valueExpression", [-2100, 450], { expressions: cutStatements((60 / track.bpm) * track.beatsPerBar), defaults: CUT_DEFAULTS }, { label: "expression_cut" }),
    node("select_want", "valueSelect", [-1800, 450], { channels: "want" }, { label: "select_want" }),
    node("count_cuts", "valueCount", [-1500, 450], { threshold: 0.5, holdoff: expressionSlot("op('expression_cut').chan.hold", 3.2) }, { label: "count_cuts" }),
    // What the track is doing (director.ts): this passage's loudness against what it has
    // usually been lately (slow to fall), and against the quietest it has lately been (falls at
    // once, slow to rise). The level is the clip's own, not the ranked one: a rank has no silence.
    node("select_loud", "valueSelect", [-2700, 650], { channels: "level" }, { label: "select_loud" }),
    node("lag_loud", "valueLag", [-2400, 650], { lag: 0.8, releaseRatio: 1.5 }, { label: "lag_loud" }),
    node("lag_usual", "valueLag", [-2100, 600], { lag: 4, releaseRatio: 4 }, { label: "lag_usual" }),
    node("lag_floor", "valueLag", [-2100, 725], { lag: 8, releaseRatio: 0.06 }, { label: "lag_floor" }),
    node("constant_energy", "constant", [-1800, 600], { value: expressionSlot(against("op('lag_loud').chan.level", "op('lag_usual').chan.level"), 0) }, { label: "constant_energy" }),
    node("constant_lift", "constant", [-1800, 725], { value: expressionSlot(against("op('lag_loud').chan.level", "op('lag_floor').chan.level"), 0) }, { label: "constant_lift" }),
    // Seconds since the last kick: what times a pulse down the tentacles.
    node("select_kick", "valueSelect", [-3300, 900], { channels: "kickCount" }, { label: "select_kick" }),
    node("count_kick", "valueCount", [-3000, 900], { threshold: 0.5, holdoff: 0.1 }, { label: "count_kick" }),

    // ── How far it has come: a rate, eased, integrated, wrapping where the path does ──
    // Perch stops it (the panel's, or a breakdown gone nearly silent: director.ts). No drum moves the body: it
    // travels smoothly, and the track shows in its lights. (The lunge of a swimming stroke is the rig's own, on the
    // GPU: the rate cannot read how far it has come without the value graph closing a loop,
    // and a loop there is dropped whole.)
    node("constant_rate", "constant", [-2400, 1000], {
      value: expressionSlot(`${on("slider_speed")} * (1 - op('constant_perch').chan.value) * ${pace(FOLLOW, ENERGY)} * ${stride(`(${FOLLOW} * (${ENERGY} > 0))`, INTENSITY)} * (1 - 0.6 * ${ATTACK})`, 3.2),
    }, { label: "constant_rate" }),
    // The speed it is asked for follows the track's loudness, which ripples with every beat; a body does not.
    // Eased over two and a half seconds both ways, the ripple is gone and a stop or a start is a glide.
    // (Measured on the owner's track, thirty seconds of walking: with a quarter-second ease the speed changed
    // direction 2.8 times a second and accelerated at up to 1.9 m/s².)
    node("lag_rate", "valueLag", [-2100, 1000], { lag: 2.5, releaseRatio: 1 }, { label: "lag_rate" }),
    // Perch, eased: how perched it is, 0 to 1, for the head and the tentacles it frees.
    // How much it swims: the panel's Swim, or the track coming back in (director.ts). Eased, so
    // letting go of the wall and taking hold again each take a moment.
    node("constant_swim", "constant", [-1500, 725], { value: expressionSlot(`max(max(${on("slider_swim")}, smoothstep(1.1, 1.6, op('lag_pack').chan.value)), max(${surge(FOLLOW, LIFT)}, ${phraseSwim(FOLLOW, INTENSITY, phraseDraw(BAR, 1))}) * (1 - ${phraseAttack(FOLLOW, INTENSITY, phraseDraw(BAR, 3))}))`, 0) }, { label: "constant_swim" }),
    // The attack and the corkscrew: the panel's, or the phrase's. The attack comes on in under a second; the
    // corkscrew winds up over several, because while it changes, the rungs a claw holds go round under it.
    node("constant_attack", "constant", [-1500, 975], { value: expressionSlot(`max(${on("slider_attack")}, ${phraseAttack(FOLLOW, INTENSITY, phraseDraw(BAR, 3))} * (${ENERGY} > 0))`, 0) }, { label: "constant_attack" }),
    node("lag_attack", "valueLag", [-1200, 975], { lag: 0.7, releaseRatio: 1.4 }, { label: "lag_attack" }),
    node("constant_spiral", "constant", [-1500, 1100], { value: expressionSlot(`max(${on("slider_spiral")}, 0.5 * ${phraseSpiral(FOLLOW, INTENSITY, phraseDraw(BAR, 4))} * (${ENERGY} > 0))`, 0) }, { label: "constant_spiral" }),
    node("lag_spiral", "valueLag", [-1200, 1100], { lag: 5, releaseRatio: 1 }, { label: "lag_spiral" }),
    // How far round it has got, in turns: the corkscrew's tightness times the distance it covers, summed. (An
    // integrator starts at the middle of its range; the half turn is taken off where it is read.)
    node("constant_winding", "constant", [-900, 1100], { value: expressionSlot(`${SPIRAL} * op('lag_rate').chan.value / 16`, 0) }, { label: "constant_winding" }),
    node("speed_winding", "valueSpeed", [-600, 1100], { minimum: 0, maximum: 1, limit: "loop" }, { label: "speed_winding" }),
    node("lag_swim", "valueLag", [-1200, 725], { lag: 0.8, releaseRatio: 1.5 }, { label: "lag_swim" }),
    // The long view: the passage's loudness ranked against the last minute's, eased.
    node("normalize_intensity", "valueNormalize", [-2100, 850], { window: 60 }, { label: "normalize_intensity" }),
    node("lag_intensity", "valueLag", [-1800, 850], { lag: 2, releaseRatio: 1 }, { label: "lag_intensity" }),
    node("constant_perch", "constant", [-2400, 1125], { value: expressionSlot(`max(${on("toggle_perch")}, max(${rest(FOLLOW, ENERGY)}, max(${phrasePerch(FOLLOW, INTENSITY, phraseDraw(BAR, 2))}, ${phrasePause(FOLLOW, INTENSITY, phraseDraw(BAR, 5), BAR)}) * (${ENERGY} > 0)))`, 0) }, { label: "constant_perch" }),
    // The pack: how many are out. A follower takes eight seconds to come up or fall back, so the number is eased.
    // In the fields all of them are out, and are called up two bars before it gets there.
    node("constant_pack", "constant", [-1500, 1225], { value: expressionSlot(`max(max(${on("slider_pack")}, ${PACK.length} * ${PLACE_SOON}), ${packSize(`(${FOLLOW} * (${ENERGY} > 0))`, phraseDraw(BAR, 6, PACK_BARS), PACK.length)})`, 1) }, { label: "constant_pack" }),
    // Which place it is in, under a name of its own for the camera: an Expression node reads its wires into one bag by channel name.
    node("expression_packing", "valueExpression", [-900, 1100], { expressions: "packing = value", defaults: "value = 1" }, { label: "expression_packing" }),
    node("constant_place", "constant", [-1500, 1350], { value: expressionSlot(PLACE, 0) }, { label: "constant_place" }),
    node("expression_placed", "valueExpression", [-900, 1350], { expressions: "place = value", defaults: "value = 0" }, { label: "expression_placed" }),
    node("lag_pack", "valueLag", [-1200, 1225], { lag: 4, releaseRatio: 1 }, { label: "lag_pack" }),
    // Under a name of its own for the camera, which stands back behind however many are out (see expression_placed).
    node("expression_packed", "valueExpression", [-900, 1225], { expressions: "pack = value", defaults: "value = 1" }, { label: "expression_packed" }),
    node("lag_perched", "valueLag", [-2100, 1125], { lag: 0.6, releaseRatio: 1 }, { label: "lag_perched" }),
    node("speed_travel", "valueSpeed", [-1800, 1000], { minimum: 0, maximum: PATH.period, limit: "loop" }, { label: "speed_travel" }),
    // The swimming beat: one stroke per bar of the track.
    node("constant_stroke", "constant", [-2400, 1250], { value: track.bpm / 60 / track.beatsPerBar }, { label: "constant_stroke" }),
    node("speed_stroke", "valueSpeed", [-2100, 1250], { minimum: 0, maximum: 1, limit: "loop" }, { label: "speed_stroke" }),

    // ── The robot: for each piece a mesh of the kit, the rig's points of that piece, and the draw (T1581b) ──
    node("material_hull", "materialWgsl", [-1800, 150], {
      model: "pbr",
      source: HULL_SURFACE_WGSL,
      // The eyes flicker with the hats and swell with the top of the track.
      eyeGlow: expressionSlot(`${on("slider_glow")} * (0.75 + ${HIGH} * 0.6) * (1 + 0.8 * ${ATTACK})`, 9),
      // One colour range for every light on it; the level moves them along it.
      hueFrom: expressionSlot(on("slider_huefrom"), 0),
      hueTo: expressionSlot(on("slider_hueto"), 0.03),
      spread: expressionSlot(on("slider_spread"), 0.6),
      shift: expressionSlot(HUE_SHIFT, 0),
      // The face: a third of the lenses each to kick, snare and hat, and a band of light across it once a beat.
      eyeHits: expressionSlot(`min(1, ${on("slider_eyehits")} * ${STILL_GAIN})`, 0.6),
      kick: expressionSlot(KICK, 0),
      snare: expressionSlot(SNARE, 0),
      hat: expressionSlot(HAT, 0),
      eyeSweep: expressionSlot(on("slider_eyesweep"), 0.25),
      sweepPhase: expressionSlot(`${STROKE} * ${track.beatsPerBar}`, 0),
      // What the steel has to reflect (tunnel.ts): the lamps round the robot, each where its light would hang.
      // They breathe as the lights do.
      ...Object.fromEntries(mirrored.flatMap((lamp, index) => (["x", "y", "z"] as const).map((axis) => [`${lampParameter(index)}.${axis}`, lamp.position[axis]]))),
      station: expressionSlot(`floor(${TRAVEL} / ${LAMP_SPACING})`, 37),
      lamps: expressionSlot(`${on("slider_lamp")} * 0.23 * ${LAMP_BREATH} * (1 - ${PLACE})`, 6),
      air: expressionSlot(`0.55 * ${PLACE}`, 0),
      // How bright a kick's pulse is as it runs down the cores (the rig says where it is).
      pulseGlow: expressionSlot(`1.6 * ${on("slider_legs")}`, 1.6),
      // At rest the segments glow low; Leg Lights at 0 puts them out.
      coreGlow: expressionSlot(`0.07 * min(${on("slider_legs")}, 1)`, 0.07),
    }, { label: "material_hull" }),

    ...legNodes,
    ...pieceNodes({
      travel,
      ...look,
      // Perched, the last three tentacles to take the wall let go of it and feel about.
      crawl: expressionSlot(`${on("slider_crawl")} * (1 - 0.3 * ${PERCHED})`, 1),
      // Only perched does it feel about, and it comes to that slowly. (The track does not move the tentacles:
      // the lows pumping this made the free ones snap between two shapes on every beat.)
      gesture: expressionSlot(`${on("slider_gesture")} * ${PERCHED}`, 0),
      // A hat clacks the idle claws.
      snap: expressionSlot(HAT, 0),
      // Every kick sends a pulse down the cores; the lows fill them like a meter; bands run out on the beat
      // (dimly even in silence: it is never quite dark); the hats spark single cores.
      pulse: expressionSlot("op('count_kick').chan.kickCountSince", 100),
      attack: expressionSlot(ATTACK, 0),
      pack: expressionSlot("op('lag_pack').chan.value", 1),
      company: expressionSlot("clamp(op('lag_pack').chan.value - 1, 0, 1)", 0),
      ...(ropes ? { follow: expressionSlot(on("slider_follow"), 0.4) } : {}),
      afield: expressionSlot(PLACE, 0),
      spiral: expressionSlot(SPIRAL, 0),
      spiralTurn: expressionSlot("op('speed_winding').chan.value - 0.5", 0),
      meter: expressionSlot(`${on("slider_meter")} * ${LOW}`, 0),
      chase: expressionSlot(`${on("slider_chase")} * (0.1 + ${HIGH} * 0.9) * ${STILL_GAIN}`, 0.05),
      chasePhase: expressionSlot(`${STROKE} * ${track.beatsPerBar}`, 0),
      spark: expressionSlot(`${on("slider_spark")} * ${HAT}`, 0),
      ...swimming,
      stride: expressionSlot(on("slider_stride"), 3.2),
      flare: expressionSlot(on("slider_flare"), 0.25),
      // The low end runs down the tentacles.
      wave: expressionSlot(on("slider_wave"), 0.05),
      grip: expressionSlot(on("slider_grip"), 1),
      bore: expressionSlot(on("slider_bore"), 2.6),
    }),

    // ── The tunnel: one grid bent into the bore, a window of it riding with the robot ──
    node("grid_bore", "pointGrid", [-2400, 1200], { cols: BORE_COLUMNS, rows: BORE_ROWS, count: BORE_COLUMNS * BORE_ROWS, sizeX: 2, sizeY: 2 }, { label: "grid_bore" }),
    node("kernel_bore", "pointKernel", [-2100, 1200], { capacity: BORE_COLUMNS * BORE_ROWS, attributes: BORE_ATTRIBUTES, kernel: BORE_KERNEL, travel, bore: expressionSlot(on("slider_bore"), 2.6), place: expressionSlot(PLACE, 0) }, { label: "kernel_bore" }),
    node("material_bore", "materialWgsl", [-2100, 1400], { model: "pbr", source: BORE_SURFACE_WGSL, lamp: expressionSlot(`${on("slider_lamp")} * 0.55 * ${LAMP_BREATH} * (1 - ${PLACE})`, 14), bore: expressionSlot(on("slider_bore"), 2.6) }, { label: "material_bore" }),
    node("geometry_bore", "geometry", [-1800, 1200], { mode: "surface", material: "material_bore", tint: map("tint", [0, 0, 0, 0]) }, { label: "geometry_bore" }),

    // ── Air: dust that the lamps and the eyes light on its way to a wall ──
    // ── THE FIELDS (field.ts): towers and the pods on them, each a strip of points a Sweep skins. Out of the
    // fields every strip is one point of no radius. ──
    node("kernel_towers", "pointKernel", [-3600, 4200], { capacity: TOWER_CAPACITY, attributes: FIELD_ATTRIBUTES, kernel: TOWER_KERNEL, travel, place: expressionSlot(PLACE, 0) }, { label: "kernel_towers" }),
    node("topology_towers", "pointTopology", [-3300, 4200], { connectivity: "strips", cols: FIELD.towerPoints, rows: FIELD_TOWERS }, { label: "topology_towers" }),
    // A tower goes straight up, so its frame leans on the world's X, not on up.
    node("frames_towers", "pointCurveFrames", [-3000, 4200], { method: "minimiseTwist", up: [1, 0, 0] }, { label: "frames_towers" }),
    node("sweep_towers", "pointSweep", [-2700, 4200], { profile: "ring", sides: 10, radius: map("girth", 1) }, { label: "sweep_towers" }),
    node("material_tower", "materialWgsl", [-2700, 4400], { model: "pbr", source: TOWER_SURFACE_WGSL, ...fieldLight }, { label: "material_tower" }),
    node("geometry_towers", "geometry", [-2400, 4200], { mode: "surface", material: "material_tower", tint: map("tint", [0, 0, 0, 0]) }, { label: "geometry_towers" }),
    node("kernel_pods", "pointKernel", [-3600, 4650], { capacity: POD_CAPACITY, attributes: FIELD_ATTRIBUTES, kernel: POD_KERNEL, travel, place: expressionSlot(PLACE, 0) }, { label: "kernel_pods" }),
    node("topology_pods", "pointTopology", [-3300, 4650], { connectivity: "strips", cols: FIELD.podPoints, rows: POD_COUNT }, { label: "topology_pods" }),
    node("frames_pods", "pointCurveFrames", [-3000, 4650], { method: "minimiseTwist", up: [0, 1, 0] }, { label: "frames_pods" }),
    node("sweep_pods", "pointSweep", [-2700, 4650], { profile: "ring", sides: 6, radius: map("girth", 1) }, { label: "sweep_pods" }),
    node("material_pod", "materialWgsl", [-2700, 4850], { model: "pbr", source: POD_SURFACE_WGSL, ...fieldLight }, { label: "material_pod" }),
    node("geometry_pods", "geometry", [-2400, 4650], { mode: "surface", material: "material_pod", tint: map("tint", [0, 0, 0, 0]) }, { label: "geometry_pods" }),
    node("kernel_motes", "pointKernel", [-2100, 1600], {
      capacity: MOTE_COUNT,
      attributes: MOTE_ATTRIBUTES,
      kernel: MOTE_KERNEL,
      travel,
      bore: expressionSlot(on("slider_bore"), 2.6),
      lamp: expressionSlot(`${on("slider_lamp")} * ${LAMP_BREATH} * (1 - ${PLACE})`, 26),
      eyes: expressionSlot(`${on("slider_glow")} * 0.9 * (0.75 + ${HIGH} * 0.6) * ${faceLevel}`, 8),
      eyeColor: [1, 0.04, 0.04, 1],
      "eyeColor.r": expressionSlot(eyeTone[0], 1),
      "eyeColor.g": expressionSlot(eyeTone[1], 0.04),
      "eyeColor.b": expressionSlot(eyeTone[2], 0.04),
    }, { label: "kernel_motes" }),
    node("material_motes", "materialUnlit", [-2100, 1800], { color: [1, 1, 1, 1] }, { label: "material_motes" }),
    node("geometry_motes", "geometry", [-1800, 1600], { mode: "points", material: "material_motes", blend: "additive", soft: 1, spherical: true, scale: map("tint", 0.016, "w"), tint: map("tint", [0, 0, 0, 1]) }, { label: "geometry_motes" }),

    // ── Camera and light ──
    node("expression_camera", "valueExpression", [-1800, -600], { expressions: CAMERA_STATEMENTS, defaults: CAMERA_DEFAULTS }, { label: "expression_camera" }),
    // The lens holds its length. (A kick used to punch it in 2.5 degrees; the owner, 2026-10-06: "the very prominent
    // and constant camera punching … feels a bit irritating as it's not necessarily only tracking the kick … a bit
    // jarring". What answers the kick now is the focus, some phrases, and the robot and the place themselves.)
    node("camera_rig", "camera", [-1500, -600], { eye: [1.1, 0.6, -7.5], lookAt: [0, 0, 3.3], "eye.x": eye.x, "eye.y": eye.y, "eye.z": eye.z, "lookAt.x": aim.x, "lookAt.y": aim.y, "lookAt.z": aim.z, fov: expressionSlot(RIG("lens"), 55), near: 0.05, far: 240 }, { label: "camera_rig" }),
    // The eyes throw the tentacles' shadows down the walls (which of the scene casts them: see `robotCasts`).
    node("light_eyes", "light", [-1500, -300], { kind: "point", color: [1, 0.04, 0.04, 1], "color.r": expressionSlot(eyeTone[0], 1), "color.g": expressionSlot(eyeTone[1], 0.04), "color.b": expressionSlot(eyeTone[2], 0.04), intensity: expressionSlot(`${on("slider_glow")} * 0.9 * (0.75 + ${HIGH} * 0.6) * ${faceLevel}`, 8), position: [0, 0, 0.9], "position.x": glow.x, "position.y": glow.y, "position.z": glow.z, falloff: "inverseSquare", range: 16, ...(shadows ? { shadows: true, shadowExtent: 16, shadowSoftness: 1 } : {}) }, { label: "light_eyes" }),
    // The light of its own tentacles, from the middle of the body. It lights the bore round the robot wherever
    // the robot is, lamp or no lamp, and throws each tentacle's shadow out along the wall to meet the claw that
    // holds it: that meeting is what says the robot is IN the tunnel. (The owner, 2026-10-05: without it "a very
    // bad composite".) The hull does not cast for it: the light is inside the hull.
    node("light_body", "light", [-1500, -450], {
      kind: "point", color: [1, 0.04, 0.04, 1], "color.r": expressionSlot(legTone[0], 1), "color.g": expressionSlot(legTone[1], 0.04), "color.b": expressionSlot(legTone[2], 0.04),
      intensity: expressionSlot(`${legLevel} * 2.6`, 1.3),
      position: [0, 0, -0.3], "position.x": core.x, "position.y": core.y, "position.z": core.z,
      falloff: "inverseSquare", range: 12, shadows: true, shadowExtent: 12, shadowSoftness: 1.5,
      shadowCasters: hingedClaws ? "geometry_ring geometry_hub" : "geometry_ring geometry_claw",
    }, { label: "light_body" }),
    // Each follower of the pack throws its own light too, or it is a row of dots in the dark and not a robot in a
    // tunnel: one light at its middle, the legs' colour, as bright as it is out (and where it is: coming up from behind).
    ...followers.map((follower, index) =>
      node(`light_follower${index + 1}`, "light", [-1500 + (index + 1) * 300, -450], {
        kind: "point", color: [1, 0.04, 0.04, 1], "color.r": expressionSlot(legTone[0], 1), "color.g": expressionSlot(legTone[1], 0.04), "color.b": expressionSlot(legTone[2], 0.04),
        intensity: expressionSlot(`${legLevel} * 2.6 * ${follower.out}`, 0),
        position: [0, 0, 0], "position.x": follower.at.x, "position.y": follower.at.y, "position.z": follower.at.z,
        falloff: "inverseSquare", range: 10,
      }, { label: `light_follower${index + 1}` }),
    ),
    // ── EVERY LAMP OF THE TUNNEL IS A LIGHT (§T1589b): one Light, standing on a point for each lamp station of the
    // lap (tunnel.ts, LAMP_KERNEL). They breathe with the low end, and in the fields they are out. ──
    node("kernel_lamps", "pointKernel", [-1800, -900], {
      capacity: LAMP_COUNT,
      attributes: LAMP_ATTRIBUTES,
      kernel: LAMP_KERNEL,
      travel,
      bore: expressionSlot(on("slider_bore"), 2.6),
      lamp: expressionSlot(`${on("slider_lamp")} * ${LAMP_BREATH} * (1 - ${PLACE})`, 26),
      named: namedLamps.length > 0 ? 1 : 0,
    }, { label: "kernel_lamps" }),
    // Spots, shining down: a lamp is a plate in the crown, and a plate lights what is under it and not the crown
    // beside it. Wide and soft (the full angle 150 degrees, fading over most of it), as the lit air under it is.
    node("light_lamps", "light", [-1500, -900], { kind: "spot", mode: "points", direction: [0, -1, 0], cone: 150, coneSoftness: 0.8, color: map("tint", [1, 1, 1, 1]), intensity: map("power", 1), falloff: "inverseSquare", range: 24 }, { label: "light_lamps" }),
    // The three nearest the robot as Lights of their own, where a lamp's shadow is wanted: a Light in Points
    // mode casts none. Offline only (see robotCasts); the kernel above dims those three by as much.
    ...namedLamps.map((lamp, index) =>
      node(`light_lamp${index}`, "light", [-1500, -150 + index * 150], {
        kind: "point",
        color: [0.62, 0.84, 1, 1],
        "color.r": expressionSlot(lamp.tone[0], 0.62),
        "color.g": expressionSlot(lamp.tone[1], 0.84),
        "color.b": expressionSlot(lamp.tone[2], 1),
        // No tunnel, no lamps: in the fields they are out.
        intensity: expressionSlot(`${on("slider_lamp")} * ${lamp.near} * ${lamp.high} * ${LAMP_BREATH} * (1 - ${PLACE})`, index === 1 ? 26 : 0),
        position: [0, 2.25, (index - 0.5) * LAMP_SPACING],
        "position.x": lamp.position.x,
        "position.y": lamp.position.y,
        "position.z": lamp.position.z,
        falloff: "inverseSquare",
        range: 30,
        // Live, the lamp overhead throws the robot's shadow on the deck and the wall; offline, all three do, and everything's.
        ...(shadows ? { shadows: true, shadowExtent: 30, shadowSoftness: 1, ...robotCasts } : {}),
      }, { label: `light_lamp${index}` }),
    ),
    node("render_shot", "render", [-1200, 0], {
      // The dust is last: additive geometry is light, drawn over what it glows on (and out of the Depth output since B256).
      scenes: [...pieces.map((piece) => `geometry_${piece.role}`), "geometry_bore", "geometry_towers", "geometry_pods", "geometry_motes"].join(" "),
      camera: "camera_rig",
      lights: ["light_eyes", "light_body", ...followers.map((_, index) => `light_follower${index + 1}`), "light_lamps", ...namedLamps.map((_, index) => `light_lamp${index}`)].join(" "),
      ambientColor: [0.3, 0.62, 0.66, 1],
      // A little cold fill and no more: an unlit stretch may be black (the owner, 2026-10-05).
      // …and in the fields more of it: there is no wall to be black against, and the towers have only this, the
      // robots' own lights and their pods'.
      ambientIntensity: expressionSlot(`0.1 + 0.25 * ${PLACE}`, 0.1),
      background: [0, 0, 0, 1],
      // Live, no multisampling: 4x on this much geometry was the largest single cost of the frame (measured in the
      // app, shadows on: 36 to 42 frames a second with it, 45 to 58 without), and the focus, the grain and the lens
      // that follow soften an edge anyway. Offline keeps it.
      antialias: offline ? "msaa" : "none",
      depthOutput: true,
      normalOutput: true,
    }, { label: "render_shot" }),
    // ── Reflections: the wet deck and the wet streaks mirror the eyes and the lamps (the furnace's
    // screen-space pass, until a stock one exists, T1372b). It reads the camera off the camera node. ──
    // ── THE FINISH: mirror the wet, darken the creases, fill the air, focus, bloom, a lens, film ──
    // (the screen-space passes and the bloom are the furnace's until stock ones exist, §T1402b)
    node("wgsl_reflect", "customWgslMulti", [-1050, 0], {
      source: SSR_WGSL,
      ...lens,
      // Only the wettest surfaces mirror, and not at full strength: the pass is jittered and
      // has no temporal filter here, so anything more reads as sparkle.
      strength: 0.6,
      maxDistance: 30,
      thickness: 0.5,
      roughnessCutoff: 0.26,
    }, { label: "wgsl_reflect", resolution: { mode: "project" } }),
    // Contact: where a claw meets the wall, under a pipe, in every crease, the frame is darker. The
    // Render's own occlusion touches only the ambient term, and there is next to none of that here.
    node("wgsl_occlusion", "customWgslMulti", [-975, 150], { source: GTAO_WGSL, ...lens, radius: 0.8, strength: 0.85, power: 1.5 }, { label: "wgsl_occlusion", resolution: { mode: "project" } }),
    // Air: haze, and the glow of lit air round each lamp and round the face (tunnel.ts).
    node("wgsl_haze", "customWgslMulti", [-900, 0], {
      source: HAZE_WGSL,
      ...lens,
      // The fields are a far bigger dark: thinner air, so a tower two hundred metres off is still a shape, and colder.
      density: expressionSlot(`${on("slider_haze")} * (1 - 0.6 * ${PLACE})`, 0.04),
      color: [0.016, 0.04, 0.044, 1],
      // …and far lighter than the towers, which are black: a tower is a shape against the air, as in the film.
      "color.r": expressionSlot(`0.016 + 0.062 * ${PLACE}`, 0.016),
      "color.g": expressionSlot(`0.04 + 0.14 * ${PLACE}`, 0.04),
      "color.b": expressionSlot(`0.044 + 0.25 * ${PLACE}`, 0.044),
      // More air, more of it lit.
      glow: expressionSlot(`${on("slider_haze")} * 0.05`, 0.002),
      ...Object.fromEntries(mirrored.flatMap((lamp, index) => (["x", "y", "z"] as const).map((axis) => [`${lampParameter(index)}.${axis}`, lamp.position[axis]]))),
      station: expressionSlot(`floor(${TRAVEL} / ${LAMP_SPACING})`, 37),
      lamp: expressionSlot(`${on("slider_lamp")} * ${LAMP_BREATH} * (1 - ${PLACE})`, 26),
      eyesAt: [0, 0, 0.9],
      "eyesAt.x": glow.x,
      "eyesAt.y": glow.y,
      "eyesAt.z": glow.z,
      eyeColor: [1, 0.04, 0.04, 1],
      "eyeColor.r": expressionSlot(eyeTone[0], 1),
      "eyeColor.g": expressionSlot(eyeTone[1], 0.04),
      "eyeColor.b": expressionSlot(eyeTone[2], 0.04),
      // The face is a small light close to the lens: the air shows it more than its reach on the walls would say.
      eyes: expressionSlot(`${on("slider_glow")} * 0.7 * (0.75 + ${HIGH} * 0.6) * ${faceLevel}`, 6),
    }, { label: "wgsl_haze", resolution: { mode: "project" } }),
    // Focus: on the robot, wherever the shot stands; what is nearer or further goes soft, and a long lens softer.
    node("wgsl_focus", "customWgslMulti", [-750, 0], {
      source: DOF_WGSL,
      ...lens,
      // On the robot's face, or on the tail when that is what the shot looks at.
      focusDistance: expressionSlot(`max(((${RIG("ahead")} - min(${RIG("aim")}, 0.4)) * (${RIG("ahead")} - min(${RIG("aim")}, 0.4)) + ${RIG("right")} * ${RIG("right")} + ${RIG("up")} * ${RIG("up")}) ^ 0.5, 0.6)`, 7.5),
      // …and some phrases (nearly half of them) the kick opens the lens: what is not the robot goes softer for a
      // moment and comes back, in place of the punch (the owner: "maybe occasionally we drive DOF instead").
      aperture: expressionSlot(`${on("slider_focus")} * 55 / ${RIG("lens")} * (1 + ${on("slider_pump")} * 1.4 * ${KICK} * (${phraseDraw(BAR, 11)} < 0.45))`, 0.5),
      maxRadius: 14,
    }, { label: "wgsl_focus", resolution: { mode: "project" } }),
    node("wgsl_bright", "customWgsl", [-600, 300], { source: BRIGHT_PASS_WGSL, threshold: 1.4, knee: 1 }, { label: "wgsl_bright", resolution: { mode: "scale", factor: 0.5 } }),
    ...[1, 2, 3, 4].map((level) => node(`wgsl_bloomdown${level}`, "customWgsl", [-300, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, { label: `wgsl_bloomdown${level}`, resolution: { mode: "scale", factor: 0.5 } })),
    ...[0, 1, 2, 3].map((level) => node(`wgsl_bloomup${level}`, "customWgslMulti", [0, 150 + level * 150], { source: BLOOM_UP_WGSL, lower: 1 }, { label: `wgsl_bloomup${level}`, resolution: { mode: "scale", factor: 2 } })),
    node("add_glow", "add", [300, 0], { opacity: 0.4 }, { label: "add_glow", resolution: { mode: "project" } }),
    // A lens that is not perfect, and film: a little barrel, soft fringed edges, a vignette; then the
    // grade (a filmic curve, crushed blacks, green in the shadows as the film has it) and grain.
    node("lens_glass", "lens", [450, 0], { distortion: 0.035, edgeBlur: 0.008, swirl: 0.3, aberration: 0.0012, vignette: 0.6, vignetteRound: 0.8 }, { label: "lens_glass", resolution: { mode: "project" } }),
    node("filmgrade_finish", "filmGrade", [600, 0], {
      exposure: 0.3, black: 0.03, contrast: 1.2, saturation: 0.92, keepWarm: 1, bleach: 0.2,
      shadowTint: [0.78, 1, 0.9, 1], highlightTint: [1, 0.97, 0.92, 1], split: 0.55,
      grain: expressionSlot(on("slider_grain"), 0.06), grainSize: 1.5,
    }, { label: "filmgrade_finish", resolution: { mode: "project" } }),
    // The grade has already tone mapped.
    node("output_frame", "output", [750, 0], { toneMap: "none" }, { label: "output_frame" }),

    // ── The panel: the piece's own words ──
    ...controls,
    ...banks,
    ...panels.map((panel, index) => node(panel.id, "panel", [-2400 + index * 300, 3500], { title: panel.title, board: panel.board, remote: true }, { label: panel.id })),
    node(everything.id, "panel", [-1500, 3500], { title: everything.title, board: everything.board, remote: false }, { label: everything.id }),
  ];

  const edges: GraphEdge[] = [
    edge("clip-levels", ["audiofile_track", "out"], ["select_levels", "in"]),
    edge("levels-smooth", ["select_levels", "out"], ["lag_smooth", "in"]),
    edge("smooth-rank", ["lag_smooth", "out"], ["normalize_levels", "in"]),
    edge("rank-levels", ["normalize_levels", "out"], ["lag_levels", "in"]),
    edge("clip-hits", ["audiofile_track", "out"], ["select_hits", "in"]),
    edge("hits-lag", ["select_hits", "out"], ["lag_hits", "in"]),
    edge("hits-rate", ["select_hits", "out"], ["rate_hits", "in"]),
    edge("rate-busy", ["rate_hits", "out"], ["expression_busy", "in"]),
    edge("busy-only", ["expression_busy", "out"], ["select_busy", "in"]),
    edge("busy-ease", ["select_busy", "out"], ["lag_busy", "in"]),
    edge("clip-bar", ["audiofile_track", "out"], ["select_bar", "in"]),
    ...["select_bar", "lag_busy", "lag_intensity"].map((source, index) => edge(`cut-${source}`, [source, "out"], ["expression_cut", "in"], index)),
    edge("cut-want", ["expression_cut", "out"], ["select_want", "in"]),
    edge("want-count", ["select_want", "out"], ["count_cuts", "in"]),
    edge("smooth-loud", ["lag_smooth", "out"], ["select_loud", "in"]),
    edge("loud-lag", ["select_loud", "out"], ["lag_loud", "in"]),
    edge("loud-usual", ["lag_loud", "out"], ["lag_usual", "in"]),
    edge("loud-floor", ["lag_loud", "out"], ["lag_floor", "in"]),
    edge("attack-ease", ["constant_attack", "out"], ["lag_attack", "in"]),
    edge("pack-ease", ["constant_pack", "out"], ["lag_pack", "in"]),
    edge("spiral-ease", ["constant_spiral", "out"], ["lag_spiral", "in"]),
    edge("winding-sum", ["constant_winding", "out"], ["speed_winding", "in"]),
    edge("loud-intensity", ["lag_loud", "out"], ["normalize_intensity", "in"]),
    edge("intensity-ease", ["normalize_intensity", "out"], ["lag_intensity", "in"]),
    edge("swim-ease", ["constant_swim", "out"], ["lag_swim", "in"]),
    edge("clip-kick", ["audiofile_track", "out"], ["select_kick", "in"]),
    edge("kick-count", ["select_kick", "out"], ["count_kick", "in"]),
    edge("rate-ease", ["constant_rate", "out"], ["lag_rate", "in"]),
    edge("ease-travel", ["lag_rate", "out"], ["speed_travel", "in"]),
    edge("perch-ease", ["constant_perch", "out"], ["lag_perched", "in"]),
    edge("stroke-rate", ["constant_stroke", "out"], ["speed_stroke", "in"]),
    // What the camera rig reads: how far the robot has come, the track's bars, and the panel.
    ...["speed_travel", "slider_shot", "toggle_cuts", "slider_distance", "xypad_view", "expression_packed", "expression_packing", "expression_placed", "count_cuts"].map((source, index) => edge(`camera-${source}`, [source, "out"], ["expression_camera", "in"], index)),
    edge("pack-named", ["lag_pack", "out"], ["expression_packed", "in"]),
    edge("packing-named", ["constant_pack", "out"], ["expression_packing", "in"]),
    edge("place-named", ["constant_place", "out"], ["expression_placed", "in"]),
    ...pieces.flatMap((piece) => [
      edge(`${piece.role}-shape`, [`mesh_${piece.role}`, "out"], [`geometry_${piece.role}`, "mesh"]),
      edge(`${piece.role}-points`, [pointsOf(piece), "out"], [`geometry_${piece.role}`, "points"]),
    ]),
    ...(ropes
      ? [edge("legs-strands", ["kernel_ring", "out"], ["topology_legs", "points"]), edge("legs-rope", ["topology_legs", "out"], ["rope_legs", "in"]), edge("legs-frames", ["rope_legs", "out"], ["frames_legs", "points"])]
      : []),
    edge("grid-bore", ["grid_bore", "out"], ["kernel_bore", "in"]),
    edge("bore-geo", ["kernel_bore", "out"], ["geometry_bore", "points"]),
    edge("motes-geo", ["kernel_motes", "out"], ["geometry_motes", "points"]),
    edge("lamps-light", ["kernel_lamps", "out"], ["light_lamps", "points"]),
    ...(["towers", "pods"] as const).flatMap((what) => [
      edge(`${what}-strips`, [`kernel_${what}`, "out"], [`topology_${what}`, "points"]),
      edge(`${what}-frames`, [`topology_${what}`, "out"], [`frames_${what}`, "points"]),
      edge(`${what}-sweep`, [`frames_${what}`, "out"], [`sweep_${what}`, "points"]),
      edge(`${what}-geo`, [`sweep_${what}`, "out"], [`geometry_${what}`, "points"]),
    ]),
    edge("shot-reflect", ["render_shot", "out"], ["wgsl_reflect", "input"]),
    edge("depth-reflect", ["render_shot", "depth"], ["wgsl_reflect", "more"], 0),
    edge("normal-reflect", ["render_shot", "normal"], ["wgsl_reflect", "more"], 1),
    edge("reflect-occlusion", ["wgsl_reflect", "out"], ["wgsl_occlusion", "input"]),
    edge("depth-occlusion", ["render_shot", "depth"], ["wgsl_occlusion", "more"], 0),
    edge("normal-occlusion", ["render_shot", "normal"], ["wgsl_occlusion", "more"], 1),
    edge("occlusion-haze", ["wgsl_occlusion", "out"], ["wgsl_haze", "input"]),
    edge("depth-haze", ["render_shot", "depth"], ["wgsl_haze", "more"], 0),
    edge("haze-focus", ["wgsl_haze", "out"], ["wgsl_focus", "input"]),
    edge("depth-focus", ["render_shot", "depth"], ["wgsl_focus", "more"], 0),
    edge("focus-bright", ["wgsl_focus", "out"], ["wgsl_bright", "input"]),
    ...[1, 2, 3, 4].map((level) => edge(`bloom-down${level}`, [level === 1 ? "wgsl_bright" : `wgsl_bloomdown${level - 1}`, "out"], [`wgsl_bloomdown${level}`, "input"])),
    ...[0, 1, 2, 3].flatMap((level) => [
      edge(`bloom-up${level}-lower`, [level === 3 ? "wgsl_bloomdown4" : `wgsl_bloomup${level + 1}`, "out"], [`wgsl_bloomup${level}`, "input"]),
      edge(`bloom-up${level}-own`, [level === 0 ? "wgsl_bright" : `wgsl_bloomdown${level}`, "out"], [`wgsl_bloomup${level}`, "more"], 0),
    ]),
    // The bloom is the FRONT layer: Add's opacity scales in1.
    edge("glow-front", ["wgsl_bloomup0", "out"], ["add_glow", "in1"]),
    edge("glow-back", ["wgsl_focus", "out"], ["add_glow", "in2"]),
    edge("glow-lens", ["add_glow", "out"], ["lens_glass", "input"]),
    edge("lens-grade", ["lens_glass", "out"], ["filmgrade_finish", "input"]),
    edge("grade-out", ["filmgrade_finish", "out"], ["output_frame", "input"]),
    ...[...panels, everything].flatMap((panel) => panel.members.map((member, index) => edge(`${panel.id}-${member}`, [member, "out"], [panel.id, "controls"], index))),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-sentinel-bot",
    name: "Sentinel Bot",
    graph: graph(nodes, edges),
    settings: settings({ outputResolution: { width: options.width ?? 1280, height: options.height ?? 720 }, randomSeed: 23 }),
    assets: [],
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
}
