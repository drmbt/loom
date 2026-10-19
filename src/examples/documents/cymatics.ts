import type { GraphNode } from "../../domain/types/graph.ts";
import { LIMITS, document, edge, expressionSlot, graph, named, node, settings } from "./builders.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import { serializePresetBank, type Preset } from "../../domain/presets/bank.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../build-showcase-beat.ts";
import {
  CYMATICS_HEIGHT_WGSL,
  CYMATICS_HUD_WGSL,
  CYMATICS_PLATE_FIELD_WGSL,
  CYMATICS_PLATE_MODES_WGSL,
  CYMATICS_PLATE_SLOTS,
  CYMATICS_SAND_ATTRIBUTES,
  CYMATICS_SAND_CAPACITY,
  CYMATICS_SAND_KERNELS,
  CYMATICS_SAND_KERNEL,
  CYMATICS_SAND_SIZE,
  CYMATICS_MOMENTUM_WGSL,
  CYMATICS_SURFACE_WGSL,
} from "../shaders/cymatics.wgsl.ts";

/**
 * E89 CYMATICS — a dish of liquid on a speaker, filmed from above under a rig of coloured
 * lamps. Three ways to play it: a LAB (a signal generator with harmonics, a second tone and a
 * frequency sweep), a TOUR (ten seconds a note round the circle of fifths, the rig changing
 * palette between notes) and a SONG (the shipped beat's spectrum rows drive the partials, the
 * kick drops into the water and flashes the lamps). The instrument panel (an oscilloscope
 * tracing the drive, and the frequency in hertz) sits beside the dish when Scope is up.
 *
 *   feedback_state(feedback, substeps ← slider_speed) ─► wgsl_momentum(customWgsl) ─► wgsl_height(customWgsl)
 *        ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ source: "wgsl_height" ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
 *   wgsl_height ─► wgsl_surface(customWgsl) ─► threshold_hot ─► blur_halo ─┐
 *                               └──────────────────────────────────────► add_glow ─► wgsl_hud(customWgsl) ─► output1
 *
 * The physics (shallow water with a Faraday drive and a meniscus) is in
 * `../shaders/cymatics.wgsl.ts`. The reference is the owner's photograph at 29.14 Hz (A#0):
 * that is the frequency the file opens on, with the Cymascope rig.
 *
 * EVERY KNOB IS A WIDGET ON `panel_cymatics`: a parameter reads `op('<widget>').chan.<channel>`
 * through an expression slot whose retained value is the widget's own default, so a host
 * with no value graph renders the same picture (E81's idiom). The Song toggle mixes the
 * audio lanes into the same expressions, so turning it off leaves the lab exactly as set.
 *
 * Audio bounds are E79's MEASURED ranges on the same clip: band109 rests 0.30–0.35 and
 * peaks ~0.60 per kick; band380 0.32–0.78; band968 0.42–0.50; band1300 0.48–0.56;
 * band3400 0.28–0.32.
 */

const SIM_SIZE = 512;
/** A wide frame: the dish fills its height, and the instrument panel has room beside it. */
const FRAME = { width: 1920, height: 1080 } as const;

const chan = (widget: string, channel: string) => `op('${widget}').chan.${channel}`;
const SONG = chan("toggle_song", "song");
const REACT = chan("slider_react", "react");
const KICK = chan("beat_kick", "band109");
const LOW = chan("lag_low", "band380");
const MID = chan("tail_mid", "band968");
const HIGH = chan("beat_high", "band1300");
const AIR = chan("tail_air", "band3400");
/** The audio lanes only count while Song is on, scaled by Reactivity. */
const songs = (lane: string) => `${SONG} * ${REACT} * ${lane}`;

/**
 * THE TOUR: a ladder of eight stops, low to high, and a long sweep home. Each stop HOLDS for
 * nine seconds, long enough for the figure to settle into its structure, then GLIDES for five
 * to the next stop (linear in semitones, so exponential in hertz). Nothing calms the water on
 * the way: the glide is where the turbulence is, and the next stop's figure grows out of it.
 *
 *   pitch     a minor-seventh arpeggio up from A#0: 0, 3, 7, 10, 14, 17, 21, 24 semitones
 *             (29.1 … 116.5 Hz), then the glide back down to A#0
 *   symmetry  the vessel climbs with the pitch, 5 … 12 lobes, switching halfway through each
 *             glide, inside the turbulence
 *   colour    the rig's palette moves with the glide, so a stop has its own colour and the
 *             transition carries the hue across
 *   signal    a pure tone, a second harmonic, a fifth above (two tones: islands and
 *             interference), a third harmonic … one per stop, crossfaded through the glide
 *
 * Off, the dial is the note.
 */
const TOUR = chan("toggle_tour", "tour");
const TOUR_AT = "abstime / 14";
const STOP = `floor(${TOUR_AT})`;
/** 0 through the hold, then 0 → 1 across the glide to the next stop. */
const GLIDE = `smoothstep(0.643, 1, fract(${TOUR_AT}))`;
/** A per-stop value, crossfaded through the glide from this stop's to the next one's. */
const glide = (value: (stop: string) => string) => `((${value(STOP)}) * (1 - ${GLIDE}) + (${value(`(${STOP} + 1)`)}) * ${GLIDE})`;
const SEMITONES = (stop: string) => `floor(mod(${stop}, 8) * 3.5)`;
const TOUR_FREQUENCY = `29.14 * 2 ^ (${glide(SEMITONES)} / 12)`;
const TOUR_PALETTE = `${TOUR} * (${STOP} + ${GLIDE})`;
/** 1 on the stops whose place in the ladder is `at`. */
const at = (...places: number[]) => (stop: string) => places.map((place) => `clamp(1 - abs(mod(${stop}, 8) - ${place}), 0, 1)`).join(" + ");
const TOUR_LOBES = `5 + mod(${STOP} + floor(${GLIDE} + 0.5), 8)`;
/** The drive frequency, swept around the dial; in Song mode the mid lane bends it up to a quarter octave. */
const FREQUENCY = `(${chan("slider_frequency", "frequency")} * (1 - ${TOUR}) + ${TOUR} * ${TOUR_FREQUENCY}) * 2 ^ (${chan("slider_sweep", "sweep")} * sin(abstime * 6.2832 * ${chan("slider_sweeprate", "sweeprate")}) + 0.25 * ${songs(MID)})`;
const DRIVE = `clamp(${chan("slider_drive", "drive")} * (1 - ${SONG} + ${SONG} * (0.55 + 0.8 * ${LOW} * ${REACT})) + 0.3 * ${songs(KICK)}, 0, 0.95)`;
const HARMONIC2 = `${chan("slider_harmonic2", "harmonic2")} + 0.8 * ${songs(MID)} + ${TOUR} * 0.5 * ${glide(at(1, 6))}`;
const HARMONIC3 = `${chan("slider_harmonic3", "harmonic3")} + 0.6 * ${songs(HIGH)} + ${TOUR} * 0.35 * ${glide(at(4, 6))}`;
const TONE = `${chan("slider_tone", "tone")} + 0.7 * ${songs(AIR)} + ${TOUR} * 0.6 * ${glide(at(3, 7))}`;
const TONE_RATIO = chan("slider_toneratio", "toneratio");
const SQUARENESS = chan("slider_squareness", "squareness");
const SHAPE = chan("slider_shape", "shape");
/** 1 while the plate (Chladni/Bessel modes) is on show instead of the liquid. */
const PLATE = chan("toggle_plate", "plate");
const SAND = chan("toggle_sand", "sand");
/** On the tour the dish shrinks a little as the note climbs, so the high stops stay readable. */
const DISH = `${chan("slider_dish", "dish")} * (1 - ${TOUR}) + ${TOUR} * 0.55 * (29.14 / (${TOUR_FREQUENCY})) ^ 0.4`;
const RADIUS = 0.47;
/** The vessel's wall: seven shallow lobes by default, the symmetry of the reference photograph. */
const LOBES = `${chan("slider_lobes", "lobes")} * (1 - ${TOUR}) + ${TOUR} * ${TOUR_LOBES}`;
const LOBE_DEPTH = 0.03;

/** Lab defaults: the reference photograph's note, a clean fundamental, Cymascope lamps. */
const DEFAULTS = {
  frequency: 29.14, sweep: 0, sweeprate: 0.05, drive: 0.3, harmonic2: 0, harmonic3: 0, toneratio: 1.5, tone: 0, rim: 1.0,
  depth: 0.5, viscosity: 0.5, tension: 0.4, speed: 40, squareness: 0, lobes: 7, shape: 0, damping: 0.005, drivepoint: 0.6, agitation: 1, powder: 0, dish: 0.55, radial: 0.3,
  palette: 0, waveheight: 1, shutter: 0.05, slowmo: 0, ring: 1.3, rings: 7, ringcolour: 0.9, spots: 0.15, elevation: 60, caustics: 0.6, rigspin: 0,
  tilt: 0, orbit: 0, zoom: 1, scope: 0, react: 1,
} as const;

type SliderSpec = readonly [channel: keyof typeof DEFAULTS, caption: string, min: number, max: number, step: number];

const SIGNAL: readonly SliderSpec[] = [
  ["frequency", "Frequency (Hz)", 5, 120, 0],
  ["drive", "Drive", 0, 0.95, 0],
  ["sweep", "Sweep (octaves)", 0, 2, 0],
  ["sweeprate", "Sweep rate (Hz)", 0, 0.5, 0],
  ["harmonic2", "2nd harmonic", 0, 1, 0],
  ["harmonic3", "3rd harmonic", 0, 1, 0],
  ["tone", "Second tone", 0, 1, 0],
  ["toneratio", "Tone ratio", 1, 4, 0],
  ["rim", "Meniscus waves", 0, 2, 0],
];
const FLUID: readonly SliderSpec[] = [
  ["depth", "Depth", 0, 1, 0],
  ["viscosity", "Viscosity", 0, 1, 0],
  ["tension", "Surface tension", 0, 1, 0],
  ["speed", "Steps per frame", 4, 96, 1],
  ["dish", "Dish size", 0.15, 2, 0],
  ["squareness", "Round → square", 0, 1, 0],
  ["lobes", "Symmetry (lobes)", 0, 12, 1],
  ["shape", "Vessel: lobed · circle · square · hexagon · lattice", 0, 4, 1],
  ["damping", "Plate damping", 0.002, 0.2, 0],
  ["drivepoint", "Plate drive point", 0, 0.95, 0],
  ["agitation", "Sand agitation", 0, 3, 0],
  ["powder", "Sand → fine powder", 0, 1, 0],
];
const LIGHT: readonly SliderSpec[] = [
  ["palette", "Lamp rig", 0, 6, 0],
  ["waveheight", "Wave height", 0.2, 4, 0],
  ["shutter", "Shutter", 0, 1, 0],
  ["slowmo", "Slow motion", -0.5, 0.5, 0],
  ["ring", "Ring lamps", 0, 3, 0],
  ["rings", "Ring rows", 1, 16, 0],
  ["ringcolour", "Ring colour", 0, 1, 0],
  ["radial", "Centre → edge colour", 0, 1, 0],
  ["spots", "Coloured lamps", 0, 3, 0],
  ["elevation", "Lamp height (°)", 5, 70, 0],
  ["rigspin", "Rig spin", -0.2, 0.2, 0],
  ["caustics", "Caustics", 0, 2, 0],
];
const VIEW: readonly SliderSpec[] = [
  ["tilt", "Camera tilt (°)", 0, 70, 0],
  ["orbit", "Camera orbit (°)", -180, 180, 0],
  ["zoom", "Zoom", 0.5, 3, 0],
  ["scope", "Scope + readout", 0, 1, 0],
  ["react", "Reactivity", 0, 2, 0],
];

function slider([channel, caption, min, max, step]: SliderSpec, position: readonly [number, number]): GraphNode {
  const value = DEFAULTS[channel];
  return named(channel, "slider", position, { channel, caption, value, defaultValue: value, min, max, step });
}

/** The widgets on the canvas: one column per group, 200 apart. */
const widgetColumns: ReadonlyArray<readonly [number, readonly SliderSpec[]]> = [
  [-1500, SIGNAL],
  [-1200, FLUID],
  [-900, LIGHT],
  [-600, VIEW],
];
const SLIDER_COUNT = SIGNAL.length + FLUID.length + LIGHT.length + VIEW.length;
const sliders: GraphNode[] = widgetColumns.flatMap(([x, specs]) => specs.map((spec, index) => slider(spec, [x, 1300 + index * 240])));


/**
 * THE RECIPES (§T1715b): documented figures, one button each on the Panel. Each sets the whole
 * recipe (every slider it names, so nothing lingers from the last one). Sources in the .md.
 */
type Recipe = {
  readonly frequency: number; readonly drive?: number; readonly harmonic2?: number; readonly harmonic3?: number;
  readonly tone?: number; readonly toneratio?: number; readonly rim?: number; readonly viscosity?: number;
  readonly lobes: number; readonly shape: number; readonly palette: number; readonly radial?: number;
  readonly plate?: boolean; readonly sand?: boolean;
};
const RECIPE_TARGETS = ["frequency", "drive", "harmonic2", "harmonic3", "tone", "toneratio", "rim", "viscosity", "lobes", "shape", "palette", "radial"] as const;
function recipe(name: string, r: Recipe): Preset {
  const values: Record<string, Record<string, number | boolean>> = {};
  const full = { drive: 0.3, harmonic2: 0, harmonic3: 0, tone: 0, toneratio: 1.5, rim: 1, viscosity: 0.5, radial: 0.3, ...r };
  for (const key of RECIPE_TARGETS) values[`slider_${key}`] = { value: full[key] };
  values["toggle_plate"] = { on: r.plate === true };
  values["toggle_sand"] = { on: r.sand === true };
  return { name, values };
}
const RECIPES: readonly Preset[] = [
  // The owner's reference photograph: A#0 in a seven-lobed dish.
  recipe("reference", { frequency: 29.14, lobes: 7, shape: 0, palette: 0 }),
  // Schumann 7.83 Hz is a label, not physics (no source ties it to a liquid figure); five-fold.
  recipe("schumann", { frequency: 7.83, lobes: 5, shape: 0, palette: 3, radial: 0.5, viscosity: 0.4 }),
  // The owner's G (24.5 Hz) reference: six-fold, warm.
  recipe("note_g", { frequency: 24.5, lobes: 6, shape: 0, palette: 2, radial: 0.6 }),
  // A hexagonal vessel: the liquid takes the vessel's six-fold order.
  recipe("hexagon_dish", { frequency: 29, lobes: 6, shape: 3, palette: 1 }),
  // A viscous liquid, high drive: Faraday's stripes (high dissipation selects stripes).
  recipe("honey", { frequency: 40, drive: 0.8, rim: 0.2, viscosity: 1, lobes: 0, shape: 1, palette: 2 }),
  // Edwards & Fauve 1994, two frequencies 4:5: the twelve-fold quasipattern.
  recipe("quasi_12", { frequency: 30, lobes: 12, shape: 4, palette: 5, radial: 0.6, toneratio: 1.25, plate: true }),
  // Kudrolli, Pier & Gollub 1998, 6:7: two hexagonal lattices turned against each other.
  recipe("superlattice", { frequency: 30, lobes: 6, shape: 4, palette: 3, tone: 0.8, toneratio: 1, plate: true }),
  // Chladni's square plate, sand on the nodal lines.
  recipe("chladni_square", { frequency: 47, lobes: 7, shape: 2, palette: 4, plate: true, sand: true }),
  // A hexagonal plate: the seven-ring flower.
  recipe("chladni_hexagon", { frequency: 60, lobes: 7, shape: 3, palette: 4, plate: true, sand: true }),
  // A circular plate on a seven-fold resonance (J_7, the 30.35 Hz mode spot).
  recipe("bessel_seven", { frequency: 30.35, lobes: 7, shape: 1, palette: 0, plate: true }),
];
const RECIPE_BANK_TARGETS = [...RECIPE_TARGETS.map((key) => `slider_${key}.value`), "toggle_plate.on", "toggle_sand.on"].join(" ");

/** The Panel: four groups of three columns, a caption above each. */
const groupColumns: ReadonlyArray<readonly [number, string, readonly SliderSpec[]]> = [
  [0, "Signal", SIGNAL],
  [3, "Liquid", FLUID],
  [6, "Lamps", LIGHT],
  [9, "Camera · Scope", VIEW],
];
const CYMATICS_BOARD = serializePanelBoard({
  columns: 12,
  items: [
    ...groupColumns.flatMap(([x, label, specs]) => [
      { label, rect: { x, y: 0, w: 3, h: 1 } },
      ...specs.map((spec, index) => ({ member: `slider_${spec[0]}`, rect: { x, y: 1 + index, w: 3, h: 1 } })),
    ]),
    // Under the liquid's four sliders: Song, the drop and the hand.
    { label: "Play", rect: { x: 3, y: 8, w: 3, h: 1 } },
    { member: "toggle_tour", rect: { x: 3, y: 9, w: 3, h: 1 } },
    { member: "toggle_song", rect: { x: 3, y: 10, w: 3, h: 1 } },
    { member: "button_drop", rect: { x: 3, y: 11, w: 3, h: 1 } },
    { member: "button_calm", rect: { x: 3, y: 12, w: 3, h: 1 } },
    { member: "toggle_xy", rect: { x: 9, y: 7, w: 3, h: 1 } },
    { member: "toggle_plate", rect: { x: 9, y: 8, w: 3, h: 1 } },
    { member: "toggle_sand", rect: { x: 9, y: 9, w: 3, h: 1 } },
    { member: "button_scatter", rect: { x: 9, y: 10, w: 3, h: 1 } },
    { label: "Recipes", rect: { x: 0, y: 14, w: 12, h: 1 } },
    { member: "presets_recipes", rect: { x: 0, y: 15, w: 12, h: 2 } },
  ],
});

/** `named()` whose parameters may hold slots (expressions and maps), not only static values. */
function wired(role: string, type: string, position: readonly [number, number], parameters: GraphNode["parameters"], extra: Partial<GraphNode> = {}): GraphNode {
  return named(role, type, position, {}, { ...extra, parameters: { ...parameters, ...(extra.parameters ?? {}) } });
}

export const cymaticsDocument = document(
  "e89-cymatics",
  "E89 Cymatics",
  settings({
    outputResolution: { ...FRAME },
    randomSeed: 89,
    // The load-time estimate counts every node at full frame size, the fifty widget and audio
    // nodes included, which own no texture (§B295); the compiled plan is far below 1 GiB.
    limits: { ...LIMITS, memoryBudgetBytes: 2_147_483_648 },
  }),
  graph(
    [
      // ── The liquid: one state, two passes per step, many steps per frame ──
      wired("state", "feedback", [-600, 0], {
        persistence: 1, clearColor: [0, 0, 0, 0], reset: false, source: "wgsl_height",
        // The liquid idles at one step a frame while the plate is on show.
        substeps: expressionSlot(`${chan("slider_speed", "speed")} * (1 - ${PLATE}) + ${PLATE}`, DEFAULTS.speed),
      }, {
        resolution: { mode: "fixed", width: SIM_SIZE, height: SIM_SIZE },
        format: { mode: "fixed", format: "rgba16float" },
      }),
      wired("momentum", "customWgsl", [-300, 0], {
        source: CYMATICS_MOMENTUM_WGSL,
        frequency: expressionSlot(FREQUENCY, DEFAULTS.frequency),
        drive: expressionSlot(DRIVE, DEFAULTS.drive),
        harmonic2: expressionSlot(HARMONIC2, DEFAULTS.harmonic2),
        harmonic3: expressionSlot(HARMONIC3, DEFAULTS.harmonic3),
        toneRatio: expressionSlot(TONE_RATIO, DEFAULTS.toneratio),
        tone: expressionSlot(TONE, DEFAULTS.tone),
        depth: expressionSlot(chan("slider_depth", "depth"), DEFAULTS.depth),
        viscosity: expressionSlot(chan("slider_viscosity", "viscosity"), DEFAULTS.viscosity),
        tension: expressionSlot(chan("slider_tension", "tension"), DEFAULTS.tension),
        radius: RADIUS, lobes: expressionSlot(LOBES, DEFAULTS.lobes), lobeDepth: LOBE_DEPTH, shape: expressionSlot(SHAPE, 0),
        squareness: expressionSlot(SQUARENESS, 0), dishSize: expressionSlot(DISH, DEFAULTS.dish),
        calm: expressionSlot(chan("button_calm", "calm"), 0),
      }),
      wired("height", "customWgsl", [0, 0], {
        source: CYMATICS_HEIGHT_WGSL,
        radius: RADIUS, lobes: expressionSlot(LOBES, DEFAULTS.lobes), lobeDepth: LOBE_DEPTH, shape: expressionSlot(SHAPE, 0), squareness: expressionSlot(SQUARENESS, 0),
        rim: expressionSlot(`${chan("slider_rim", "rim")} * (1 + 2 * ${songs(KICK)})`, DEFAULTS.rim),
        splash: expressionSlot(`clamp(${chan("button_drop", "drop")} + ${songs(KICK)}, 0, 1)`, 0),
        splashSeed: expressionSlot(`${chan("button_drop", "dropCount")} + ${chan("audiofile_clip", "beatCount")}`, 0),
        noise: 0.05,
        rimFocus: 1,
      }),

      // ── The plate: its modes' amplitudes in a loop, then the figure they sum to ──
      wired("modes", "feedback", [-900, -500], { persistence: 1, clearColor: [0, 0, 0, 0], reset: false, source: "wgsl_modes" }, {
        resolution: { mode: "fixed", width: CYMATICS_PLATE_SLOTS, height: 1 },
        format: { mode: "fixed", format: "rgba16float" },
      }),
      wired("modes", "customWgsl", [-600, -500], {
        source: CYMATICS_PLATE_MODES_WGSL,
        shape: expressionSlot(SHAPE, 0),
        frequency: expressionSlot(FREQUENCY, DEFAULTS.frequency),
        plateScale: 2.9,
        damping: expressionSlot(chan("slider_damping", "damping"), DEFAULTS.damping),
        symmetry: expressionSlot(LOBES, DEFAULTS.lobes),
        driveRadius: expressionSlot(chan("slider_drivepoint", "drivepoint"), DEFAULTS.drivepoint),
        settle: 0.06,
      }),
      wired("plate", "customWgsl", [-300, -500], {
        source: CYMATICS_PLATE_FIELD_WGSL,
        shape: expressionSlot(SHAPE, 0),
        radius: RADIUS, lobes: expressionSlot(LOBES, DEFAULTS.lobes), lobeDepth: LOBE_DEPTH, squareness: expressionSlot(SQUARENESS, 0),
        amplitude: 0.12,
        frequency: expressionSlot(FREQUENCY, DEFAULTS.frequency),
        dishSize: expressionSlot(DISH, DEFAULTS.dish),
        plateScale: 2.9,
        symmetry: expressionSlot(LOBES, DEFAULTS.lobes),
        second: expressionSlot(TONE, DEFAULTS.tone),
        secondRatio: expressionSlot(TONE_RATIO, DEFAULTS.toneratio),
      }, {
        resolution: { mode: "fixed", width: SIM_SIZE, height: SIM_SIZE },
        format: { mode: "fixed", format: "rgba16float" },
      }),
      // ── Sand: four million grains hopping on whatever is on show, gathering where it stands
      // still. A Point Kernel holds at most a million, so four kernels, each its own stream. ──
      ...Array.from({ length: CYMATICS_SAND_KERNELS }, (_, slot) => [
        wired(`sand${slot}`, "pointKernel", [0, -800 - slot * 260], {
          capacity: CYMATICS_SAND_CAPACITY, seed: 89 + slot, attributes: CYMATICS_SAND_ATTRIBUTES, group: "", kernel: CYMATICS_SAND_KERNEL,
          shape: expressionSlot(SHAPE, 0),
          radius: RADIUS, lobes: expressionSlot(LOBES, DEFAULTS.lobes), lobeDepth: LOBE_DEPTH, squareness: expressionSlot(SQUARENESS, 0),
          amplitude: 0.12,
          rate: expressionSlot(`3.14159265 * (${FREQUENCY}) * 0.0004 * (${DISH})`, 0.02),
          agitation: expressionSlot(chan("slider_agitation", "agitation"), DEFAULTS.agitation),
          powder: expressionSlot(chan("slider_powder", "powder"), DEFAULTS.powder),
          scatter: expressionSlot(chan("button_scatter", "scatter"), 0),
          slot,
        }),
        wired(`sand${slot}`, "renderPoints", [300, -800 - slot * 260], {
          count: CYMATICS_SAND_CAPACITY, blend: "additive", accumulate: false, sizePixels: 1, group: "", color: [1, 1, 1, 1],
        }, {
          resolution: { mode: "fixed", width: CYMATICS_SAND_SIZE, height: CYMATICS_SAND_SIZE },
          parameters: { color: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } } },
        }),
      ]).flat(),
      wired("sand01", "add", [600, -900], { opacity: 1 }),
      wired("sand23", "add", [600, -1420], { opacity: 1 }),
      wired("sand", "add", [900, -1150], { opacity: 1 }),
      wired("medium", "switch", [300, -500], { index: expressionSlot(PLATE, 0), crossfade: false }),

      // ── The picture: the lamps in the liquid, then a glow ──
      wired("surface", "customWgslMulti", [300, 0], {
        source: CYMATICS_SURFACE_WGSL,
        radius: RADIUS, lobes: expressionSlot(LOBES, DEFAULTS.lobes), lobeDepth: LOBE_DEPTH, shape: expressionSlot(SHAPE, 0), squareness: expressionSlot(SQUARENESS, 0),
        dishSize: expressionSlot(DISH, DEFAULTS.dish),
        radial: expressionSlot(chan("slider_radial", "radial"), DEFAULTS.radial),
        frequency: expressionSlot(FREQUENCY, DEFAULTS.frequency),
        waveHeight: expressionSlot(chan("slider_waveheight", "waveheight"), DEFAULTS.waveheight),
        shutter: expressionSlot(chan("slider_shutter", "shutter"), DEFAULTS.shutter),
        strobe: expressionSlot(`abstime * ${chan("slider_slowmo", "slowmo")}`, 0),
        palette: expressionSlot(`${chan("slider_palette", "palette")} + ${SONG} * floor(${chan("audiofile_clip", "bar")} / 4) + ${TOUR_PALETTE}`, DEFAULTS.palette),
        rigTurn: expressionSlot(`abstime * ${chan("slider_rigspin", "rigspin")} + 0.05 * ${songs(MID)}`, 0),
        ring: expressionSlot(chan("slider_ring", "ring"), DEFAULTS.ring),
        rings: expressionSlot(chan("slider_rings", "rings"), DEFAULTS.rings),
        ringColour: expressionSlot(chan("slider_ringcolour", "ringcolour"), DEFAULTS.ringcolour),
        spots: expressionSlot(chan("slider_spots", "spots"), DEFAULTS.spots),
        elevation: expressionSlot(chan("slider_elevation", "elevation"), DEFAULTS.elevation),
        caustics: expressionSlot(chan("slider_caustics", "caustics"), DEFAULTS.caustics),
        exposure: 2,
        tilt: expressionSlot(`${chan("slider_tilt", "tilt")} + ${TOUR} * 14 * (0.5 - 0.5 * cos(abstime * 0.07))`, DEFAULTS.tilt),
        orbit: expressionSlot(chan("slider_orbit", "orbit"), DEFAULTS.orbit),
        zoom: expressionSlot(chan("slider_zoom", "zoom"), DEFAULTS.zoom),
        flash: expressionSlot(songs(KICK), 0),
        shimmer: expressionSlot(songs(HIGH), 0),
        sand: expressionSlot(SAND, 0),
        sandTint: [1, 0.9, 0.74],
        viewEye: [0, 3.7, 0.001], viewTarget: [0, 0, 0], viewFov: 36, viewOverride: 0,
      }, { resolution: { mode: "project" } }),
      wired("hot", "threshold", [600, -250], { threshold: 0.7, softness: 0.25, channel: "luminance", compare: "greater" }),
      wired("halo", "blur", [900, -250], { size: 10, filter: "gaussian", extend: "hold" }),
      wired("glow", "add", [1200, 0], { opacity: 0.6 }),

      // The instrument panel beside the dish: the trace on a graticule, the hertz above it.
      wired("hud", "customWgsl", [1500, 0], {
        source: CYMATICS_HUD_WGSL,
        scope: expressionSlot(chan("slider_scope", "scope"), DEFAULTS.scope),
        frequency: expressionSlot(FREQUENCY, DEFAULTS.frequency),
        harmonic2: expressionSlot(HARMONIC2, DEFAULTS.harmonic2),
        harmonic3: expressionSlot(HARMONIC3, DEFAULTS.harmonic3),
        toneRatio: expressionSlot(TONE_RATIO, DEFAULTS.toneratio),
        tone: expressionSlot(TONE, DEFAULTS.tone),
        xy: expressionSlot(chan("toggle_xy", "xy"), 0),
        tint: [0.3, 1, 0.45],
      }, { resolution: { mode: "project" } }),
      node("output1", "output", [1800, 0], { toneMap: "none" }, { label: "output1" }),

      // ── The song: the shipped beat, five spectrum lanes ──
      wired("clip", "audioFileIn", [-3000, 0], {
        file: SHOWCASE_BEAT_FILE, playMode: "timeline", play: true, speed: 1, cue: false, cuePoint: 0,
        trimStart: 0, trimEnd: 0, extend: "loop", volume: 1, monitor: true,
        tempoMode: "declared", bpm: SHOWCASE_BEAT.bpm, beatsPerBar: SHOWCASE_BEAT.beatsPerBar,
        beatOffset: Math.round(SHOWCASE_BEAT_OFFSET_SECONDS * 1000) / 1000,
      }),
      wired("band109", "valueSelect", [-2700, -400], { channels: "band109" }),
      wired("kick", "valueRange", [-2400, -400], { fromLow: 0.38, fromHigh: 0.6, toLow: 0, toHigh: 1, outside: "clamp" }),
      wired("kick", "valueBeat", [-2100, -400], { threshold: 0.5, retrigger: 0.3, tail: 0.5, decay: "exponential" }),
      wired("band380", "valueSelect", [-2700, -150], { channels: "band380" }),
      wired("low", "valueRange", [-2400, -150], { fromLow: 0.32, fromHigh: 0.78, toLow: 0, toHigh: 1, outside: "clamp" }),
      wired("low", "valueLag", [-2100, -150], { lag: 0.15, releaseRatio: 3 }),
      wired("band968", "valueSelect", [-2700, 100], { channels: "band968" }),
      wired("mid", "valueRange", [-2400, 100], { fromLow: 0.4, fromHigh: 0.58, toLow: 0, toHigh: 1, outside: "clamp" }),
      wired("mid", "valueTail", [-2100, 100], { tail: 1.4, decay: "linear" }),
      wired("band1300", "valueSelect", [-2700, 350], { channels: "band1300" }),
      wired("high", "valueRange", [-2400, 350], { fromLow: 0.46, fromHigh: 0.58, toLow: 0, toHigh: 1, outside: "clamp" }),
      wired("high", "valueBeat", [-2100, 350], { threshold: 0.55, retrigger: 0.15, tail: 0.3, decay: "exponential" }),
      wired("band3400", "valueSelect", [-2700, 600], { channels: "band3400" }),
      wired("air", "valueRange", [-2400, 600], { fromLow: 0.27, fromHigh: 0.33, toLow: 0, toHigh: 1, outside: "clamp" }),
      wired("air", "valueTail", [-2100, 600], { tail: 0.35, decay: "linear" }),

      // ── The controls ──
      ...sliders,
      wired("sand", "toggle", [-300, 2740], { channel: "sand", caption: "Sand", on: false, defaultOn: false }),
      wired("scatter", "button", [-300, 2980], { channel: "scatter", caption: "Scatter sand", held: false, presses: 0 }),
      wired("plate", "toggle", [-300, 2500], { channel: "plate", caption: "Plate (Chladni)", on: false, defaultOn: false }),
      wired("tour", "toggle", [-300, 1300], { channel: "tour", caption: "Tour the notes", on: false, defaultOn: false }),
      wired("song", "toggle", [-300, 1540], { channel: "song", caption: "Song", on: false, defaultOn: false }),
      wired("drop", "button", [-300, 1780], { channel: "drop", caption: "Drop", held: false, presses: 0 }),
      wired("calm", "button", [-300, 2020], { channel: "calm", caption: "Calm the water", held: false, presses: 0 }),
      wired("xy", "toggle", [-300, 2260], { channel: "xy", caption: "Scope X-Y", on: false, defaultOn: false }),
      wired("recipes", "presets", [-300, 3220], { targets: RECIPE_BANK_TARGETS, presets: serializePresetBank({ version: 1, presets: RECIPES }) }),
      wired("cymatics", "panel", [0, 1300], { title: "Cymatics", remote: false, board: CYMATICS_BOARD }),
    ],
    [
      edge("e-state-momentum", ["feedback_state", "out"], ["wgsl_momentum", "input"]),
      edge("e-momentum-height", ["wgsl_momentum", "out"], ["wgsl_height", "input"]),
      edge("e-height-medium", ["wgsl_height", "out"], ["switch_medium", "inputs"], 0),
      edge("e-plate-medium", ["wgsl_plate", "out"], ["switch_medium", "inputs"], 1),
      edge("e-medium-surface", ["switch_medium", "out"], ["wgsl_surface", "input"]),
      ...Array.from({ length: CYMATICS_SAND_KERNELS }, (_, slot) => [
        edge(`e-medium-sand${slot}`, ["switch_medium", "out"], [`kernel_sand${slot}`, "field"]),
        edge(`e-sand${slot}-points`, [`kernel_sand${slot}`, "out"], [`points_sand${slot}`, "points"]),
      ]).flat(),
      edge("e-sand0-add", ["points_sand0", "out"], ["add_sand01", "in1"]),
      edge("e-sand1-add", ["points_sand1", "out"], ["add_sand01", "in2"]),
      edge("e-sand2-add", ["points_sand2", "out"], ["add_sand23", "in1"]),
      edge("e-sand3-add", ["points_sand3", "out"], ["add_sand23", "in2"]),
      edge("e-sand01-sum", ["add_sand01", "out"], ["add_sand", "in1"]),
      edge("e-sand23-sum", ["add_sand23", "out"], ["add_sand", "in2"]),
      edge("e-sand-surface", ["add_sand", "out"], ["wgsl_surface", "more"], 0),
      edge("e-modes-loop", ["feedback_modes", "out"], ["wgsl_modes", "input"]),
      edge("e-modes-plate", ["wgsl_modes", "out"], ["wgsl_plate", "input"]),
      edge("e-surface-hot", ["wgsl_surface", "out"], ["threshold_hot", "input"]),
      edge("e-hot-halo", ["threshold_hot", "out"], ["blur_halo", "input"]),
      edge("e-surface-glow", ["wgsl_surface", "out"], ["add_glow", "in1"]),
      edge("e-halo-glow", ["blur_halo", "out"], ["add_glow", "in2"]),
      edge("e-glow-hud", ["add_glow", "out"], ["wgsl_hud", "input"]),
      edge("e-hud-out", ["wgsl_hud", "out"], ["output1", "input"]),
      edge("e-clip-band109", ["audiofile_clip", "out"], ["select_band109", "in"]),
      edge("e-band109-kick", ["select_band109", "out"], ["range_kick", "in"]),
      edge("e-kick-beat", ["range_kick", "out"], ["beat_kick", "in"]),
      edge("e-clip-band380", ["audiofile_clip", "out"], ["select_band380", "in"]),
      edge("e-band380-low", ["select_band380", "out"], ["range_low", "in"]),
      edge("e-low-lag", ["range_low", "out"], ["lag_low", "in"]),
      edge("e-clip-band968", ["audiofile_clip", "out"], ["select_band968", "in"]),
      edge("e-band968-mid", ["select_band968", "out"], ["range_mid", "in"]),
      edge("e-mid-tail", ["range_mid", "out"], ["tail_mid", "in"]),
      edge("e-clip-band1300", ["audiofile_clip", "out"], ["select_band1300", "in"]),
      edge("e-band1300-high", ["select_band1300", "out"], ["range_high", "in"]),
      edge("e-high-beat", ["range_high", "out"], ["beat_high", "in"]),
      edge("e-clip-band3400", ["audiofile_clip", "out"], ["select_band3400", "in"]),
      edge("e-band3400-air", ["select_band3400", "out"], ["range_air", "in"]),
      edge("e-air-tail", ["range_air", "out"], ["tail_air", "in"]),
      // The Panel's members, in board order (E81's idiom: wired, Layout left empty).
      ...[...SIGNAL, ...FLUID, ...LIGHT, ...VIEW].map((spec, index) =>
        edge(`e-panel-${spec[0]}`, [`slider_${spec[0]}`, "out"], ["panel_cymatics", "controls"], index)),
      ...["toggle_tour", "toggle_song", "button_drop", "button_calm", "toggle_xy", "toggle_plate", "toggle_sand", "button_scatter"].map((widget, index) =>
        edge(`e-panel-${widget}`, [widget, "out"], ["panel_cymatics", "controls"], SLIDER_COUNT + index)),
    ],
  ),
);
