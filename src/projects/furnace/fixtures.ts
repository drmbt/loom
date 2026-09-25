import type { DecodedMarker } from "../../domain/mesh/glb.ts";
import type { FurnaceSceneFacts } from "./scene-facts.ts";
import { wgslVec3 } from "./scene-facts.ts";

/**
 * T1354b — the shop's LAMP FIXTURES, read from the Blender export (§T1363b): every
 * `lamp.<area>.<nn>` marker carries its kind, colour, lumens, cone and aim in `extras`.
 * The deferred lamp pass (lamps.ts) lights the surfaces from this table and the atmosphere
 * (atmosphere.ts) lights the smoke from it, so a fixture moved in Blender moves both.
 *
 * Areas are the director's dimmers: the whole hall can drop to black on a break while the
 * furnace keeps burning. Fixtures that ride a crane bridge (`loom_follow`) move with it.
 */

/** The dimmer groups, in the order the WGSL `areaGain` array lists them. */
export const LAMP_AREAS = ["hall", "crane", "furnace", "catwalk", "pulpit", "props"] as const;
export type LampArea = (typeof LAMP_AREAS)[number];

/** How a fixture moves: 0 fixed, 1 rides the scrap crane, 2 rides the ladle crane, 3 turns (the beacon). */
const FOLLOW: Readonly<Record<string, number>> = { crane_bridge: 1, crane2_bridge: 2 };
const TURNS = 3;
/** A rotating beacon is exported omnidirectional; what it throws is a narrow, level beam. */
const BEACON_CONE_DEG = 40;

export interface Fixture {
  readonly name: string;
  readonly kind: string;
  readonly area: LampArea;
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly lumens: number;
  /** Full cone angle, degrees; 360 is omnidirectional. */
  readonly coneDeg: number;
  readonly follow: number;
}

function numbers(value: unknown, length: number, name: string): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((entry) => typeof entry === "number")) {
    throw new Error(`Fixture ${name}: expected ${length} numbers, got ${JSON.stringify(value)}.`);
  }
  return value as number[];
}

function fixtureOf(marker: DecodedMarker): Fixture {
  const extras = marker.extras ?? {};
  const area = marker.name.split(".")[1] as LampArea;
  if (!LAMP_AREAS.includes(area)) throw new Error(`Fixture ${marker.name}: unknown area "${area}" (known: ${LAMP_AREAS.join(", ")}).`);
  const color = numbers(extras["loom_light_color"], 3, marker.name);
  const lumens = extras["loom_light_lumens"];
  const cone = extras["loom_light_cone_deg"];
  if (typeof lumens !== "number" || typeof cone !== "number") throw new Error(`Fixture ${marker.name}: lumens and cone are required extras.`);
  const follow = extras["loom_follow"];
  const kind = typeof extras["loom_light_kind"] === "string" ? (extras["loom_light_kind"] as string) : "flood";
  const beacon = kind === "beacon";
  const aim = extras["loom_light_dir"] === undefined ? undefined : numbers(extras["loom_light_dir"], 3, marker.name);
  return {
    name: marker.name,
    kind,
    area,
    position: marker.position,
    // The export's own aim: the Blender pass writes the markers without their rotation, so
    // the node's −Z is not the fixture's direction (§T1363b notes it).
    direction: beacon ? [1, 0, 0] : aim === undefined ? marker.direction : [aim[0]!, aim[1]!, aim[2]!],
    color: [color[0]!, color[1]!, color[2]!],
    lumens,
    coneDeg: beacon ? BEACON_CONE_DEG : cone,
    follow: beacon ? TURNS : typeof follow === "string" ? (FOLLOW[follow] ?? 0) : 0,
  };
}

/** Every `lamp.*` marker, in name order (stable across exports). */
export function fixturesOf(facts: FurnaceSceneFacts): Fixture[] {
  return [...facts.markers.values()]
    .filter((marker) => marker.name.startsWith("lamp."))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(fixtureOf);
}

/**
 * The fixture table as WGSL constants, shared by the lamp and atmosphere passes:
 * `LAMP_POSITION`, `LAMP_DIRECTION`, `LAMP_COLOR` (rgb × lumens), and `LAMP_SHAPE`
 * (cos of the outer half-angle, cos of the inner, area index, follow index).
 */
export function fixtureTableWgsl(fixtures: readonly Fixture[]): string {
  const count = Math.max(1, fixtures.length);
  const list = (values: string[], empty: string): string => (values.length === 0 ? empty : values.join(",\n  "));
  const shape = fixtures.map((fixture) => {
    const outer = Math.min(fixture.coneDeg, 359) / 2;
    const cosOuter = fixture.coneDeg >= 359 ? -2 : Math.cos((outer * Math.PI) / 180);
    const cosInner = fixture.coneDeg >= 359 ? -1 : Math.cos((outer * 0.6 * Math.PI) / 180);
    return `vec4f(${cosOuter.toFixed(5)}, ${cosInner.toFixed(5)}, ${LAMP_AREAS.indexOf(fixture.area)}.0, ${fixture.follow}.0)`;
  });
  return `const LAMP_COUNT: u32 = ${fixtures.length}u;
const LAMP_POSITION = array<vec3f, ${count}>(
  ${list(fixtures.map((fixture) => wgslVec3(fixture.position)), "vec3f(0.0)")});
const LAMP_DIRECTION = array<vec3f, ${count}>(
  ${list(fixtures.map((fixture) => wgslVec3(fixture.direction)), "vec3f(0.0, -1.0, 0.0)")});
const LAMP_COLOR = array<vec3f, ${count}>(
  ${list(fixtures.map((fixture) => wgslVec3([fixture.color[0] * fixture.lumens, fixture.color[1] * fixture.lumens, fixture.color[2] * fixture.lumens])), "vec3f(0.0)")});
const LAMP_SHAPE = array<vec4f, ${count}>(
  ${list(shape, "vec4f(-2.0, -1.0, 0.0, 0.0)")});
`;
}

/**
 * The WGSL a pass needs to place and aim fixture `i` this frame: the crane offsets move the
 * riders, the beacon turns, and each area's dimmer and the lamp colour are applied. The
 * pass's Params must declare the members named in {@link LAMP_PARAMS}.
 */
export const LAMP_FUNCTIONS = `
fn lampPosition(i: u32) -> vec3f {
  let follow = LAMP_SHAPE[i].w;
  return LAMP_POSITION[i] + vec3f(params.craneX * f32(follow == 1.0) + params.crane2X * f32(follow == 2.0), 0.0, 0.0);
}

fn lampDirection(i: u32, time: f32) -> vec3f {
  // The amber beacon turns about the vertical.
  let a = time * 6.2831853 * params.beaconRate;
  return select(LAMP_DIRECTION[i], vec3f(cos(a), 0.0, sin(a)), LAMP_SHAPE[i].w == 3.0);
}

fn lampHash(i: u32) -> f32 {
  return fract(sin(f32(i) * 91.3458 + 17.17) * 47453.5453);
}

// Lumens to this scene's radiance, the area dimmer, and the stutter of a failing ballast.
fn lampGain(i: u32, time: f32) -> f32 {
  var areaGain = array<f32, 6>(params.hall, params.crane, params.furnace, params.catwalk, params.pulpit, params.props);
  let failing = step(1.0 - params.failing, lampHash(i));
  let stutter = step(0.55, fract(sin(floor(time * 13.0 + f32(i) * 7.0) * 12.9898) * 43758.5453));
  return params.gain * areaGain[u32(LAMP_SHAPE[i].z)] * (1.0 - failing * stutter);
}

// The spot cone: full inside the inner angle, falling to zero at the outer.
fn lampCone(i: u32, fromLamp: vec3f, time: f32) -> f32 {
  return smoothstep(LAMP_SHAPE[i].x, LAMP_SHAPE[i].y, dot(fromLamp, lampDirection(i, time)));
}
`;

/** The Params members {@link LAMP_FUNCTIONS} reads, with their defaults and help. */
export const LAMP_PARAMS = `  gain: f32, // @default 0.004  Lumens to scene radiance for every fixture.
  hall: f32, // @default 1  Dimmer: the high bays under the roof.
  crane: f32, // @default 1  Dimmer: the floods under the crane bridges.
  furnace: f32, // @default 1  Dimmer: the wall packs on the furnace vault.
  catwalk: f32, // @default 1  Dimmer: the catwalk floods.
  pulpit: f32, // @default 1  Dimmer: the pulpit panels and its beacon.
  props: f32, // @default 1  Dimmer: the floods on columns and props.
  failing: f32, // @default 0.06  Share of fixtures whose ballast stutters.
  beaconRate: f32, // @default 0.8  Beacon turns per second.
  craneX: f32, // @default 0  Scrap crane bridge travel (drive from the rig).
  crane2X: f32, // @default 0  Ladle crane bridge travel (drive from the rig).`;
