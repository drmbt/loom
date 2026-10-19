import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { HEX_APOTHEM, PLATE_MODE_SLOTS, PLATE_TABLES_WGSL, SQUARE_HALF } from "./cymatics-plate.ts";

/**
 * E89 CYMATICS — a vibrated dish of liquid, lit by a rig of coloured lamps, filmed from above.
 *
 * THREE SHADERS AND A KERNEL, and the split is the physics.
 *
 * `CYMATICS_MOMENTUM_WGSL` and `CYMATICS_HEIGHT_WGSL` are one step of the SHALLOW-WATER
 * EQUATIONS on a staggered grid (forward-backward: velocities from the old surface, then
 * the surface from the new velocities). One texture is the whole state:
 *
 *   r  surface height h, as a share of the resting depth (total depth is 1 + h)
 *   g  x velocity on the face between this cell and its +x neighbour
 *   b  y velocity on the face between this cell and its +y neighbour
 *   a  the height change of the last step, dh — what the camera needs to know where in its
 *      cycle each point of the surface is (see the surface shader)
 *
 * Both run inside one Feedback loop whose Substeps repeats them, so a displayed frame is
 * dozens of simulation steps. A Feedback's substeps all see the SAME frame clock, so the
 * drive cannot read time: it keeps its own. The three cells at the top-left corner, outside
 * the dish, hold the oscillators' phases and the drive signal they produce, and the
 * momentum pass advances them once per step. A phase is stored as two halves (a multiple of
 * 1/256 and the remainder) because the state is rgba16float, whose 11-bit mantissa alone
 * would detune the oscillator by a few percent.
 *
 * THE DRIVE IS A FARADAY DRIVE. The speaker shakes the dish up and down; in the dish's own
 * frame that is gravity swinging, g(t) = g (1 + A s(t)). A surface wave whose own frequency
 * is HALF the drive's is pumped by that swing (parametric resonance, the Mathieu
 * instability), grows out of the noise, and saturates into a standing pattern: that is the
 * subharmonic Faraday wave every cymatics photograph shows. The rim adds the second
 * mechanism, the meniscus: where liquid meets the wall the shaking wall pumps waves inward
 * at the drive frequency itself. Viscosity damps a wave at a rate proportional to k², so a
 * high note needs more drive to break the surface, as in a real dish.
 *
 * UNITS. One grid cell is the length unit and one step the time unit. `TIME_SCALE` maps
 * hertz to cycles per step. It is CALIBRATED, not derived: at 29.14 Hz (A#0, the note of
 * the owner's reference photograph) the Faraday wavelength comes out near a tenth of the
 * dish's diameter, the scale of the reference's cells.
 *
 * `CYMATICS_SURFACE_WGSL` is the camera and the lamps; `CYMATICS_HUD_WGSL` the bench
 * oscilloscope and frequency readout beside the dish.
 */

/** Drive cycles per simulation step, per hertz. See UNITS above. */
const TIME_SCALE = "4.0e-4";

/**
 * How far out a point sits in the vessel, in the units of its radius: the wall is where this
 * equals 1 (times the radius in cells, in the simulation). One function for the liquid's walls,
 * the plate's outline and the camera's mask, so the three can never disagree.
 *
 *   shape 0  round, bent towards a square by squareness (a superellipse), with lobes on top
 *   shape 1  a circle          shape 2  a square of half-side SQUARE_HALF
 *   shape 3  a hexagon of apothem HEX_APOTHEM, an edge facing +x
 *   shape 4  a circle (the Faraday lattice's dish)
 */
const VESSEL_WGSL = `
const SQUARE_HALF: f32 = ${SQUARE_HALF};
const HEX_APOTHEM: f32 = ${HEX_APOTHEM};
fn vesselReach(d: vec2f) -> f32 {
  let shape = i32(round(params.shape));
  if (shape == 1 || shape >= 4) { return length(d); }
  if (shape == 2) { return max(abs(d.x), abs(d.y)) / SQUARE_HALF; }
  if (shape == 3) {
    let a = abs(d.x);
    let b = abs(0.5 * d.x + 0.8660254 * d.y);
    let c = abs(-0.5 * d.x + 0.8660254 * d.y);
    return max(a, max(b, c)) / HEX_APOTHEM;
  }
  let n = mix(2.0, 14.0, clamp(params.squareness, 0.0, 1.0));
  let a = abs(d) + vec2f(1e-6);
  let m = max(a.x, a.y);
  let reach = m * pow(pow(a.x / m, n) + pow(a.y / m, n), 1.0 / n);
  return reach / (1.0 + params.lobeDepth * cos(params.lobes * atan2(d.y, d.x)));
}`;

/** What both simulation passes share: the grid, the dish, and the oscillators' storage. */
const SIM_COMMON = `
const TAU: f32 = 6.28318531;
const TIME_SCALE: f32 = ${TIME_SCALE};

fn size() -> vec2i { return vec2i(textureDimensions(inputTexture)); }

fn at(p: vec2i) -> vec4f {
  return textureLoad(inputTexture, clamp(p, vec2i(0), size() - vec2i(1)), 0);
}

/**
 * The dish's centre, a fraction of a cell off the grid's: a circle drawn in cells centred
 * exactly on the grid has the grid's own four-fold symmetry, and a symmetric drive on a
 * symmetric dish can only grow symmetric patterns. A real dish is round; this one is at
 * least not square.
 */
fn centre() -> vec2f { return vec2f(size()) * 0.5 + vec2f(0.37, 0.19); }

/**
 * Inside the vessel. Its radius is in cells, and its wall may carry shallow bulges (lobes):
 * the vessel's shape is what picks a standing pattern's symmetry, so a seven-lobed wall grows
 * seven-fold mandalas where a round one, on a square grid, drifts towards the grid's four.
 */
fn wet(p: vec2i, radius: f32) -> bool {
  return vesselReach(vec2f(p) + vec2f(0.5) - centre()) < radius;
}

${VESSEL_WGSL}

/** Value noise: smooth at the scale of a few cells, so the stir is invisible but real. */
fn smoothNoise(x: vec2f) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

/** The three bookkeeping cells: (0,0) fundamental phase, (1,0) tone phase, (2,0) the signals. */
fn isBook(p: vec2i) -> bool { return p.y == 0 && p.x < 3; }

fn phaseOf(cell: vec4f) -> f32 { return cell.r + cell.g; }

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
`;

const SIM_BINDINGS = `
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
`;

/**
 * Velocities from the old surface. Pressure is gravity on the height plus surface tension on
 * its curvature; the faces are walls wherever either neighbour is outside the dish.
 */
export const CYMATICS_MOMENTUM_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  frequency: f32, // @default 29.14 Drive frequency in hertz. 29.14 Hz is A#0.
  drive: f32, // @default 0.3 Plate acceleration as a share of gravity (the Faraday drive). Past the threshold the surface breaks into standing waves at half the drive frequency.
  harmonic2: f32, // @default 0 Second harmonic (2x the fundamental), relative amplitude.
  harmonic3: f32, // @default 0 Third harmonic (3x), relative amplitude.
  toneRatio: f32, // @default 1.5 A second tone, as a multiple of the fundamental.
  tone: f32, // @default 0 The second tone's relative amplitude.
  depth: f32, // @default 0.5 Liquid depth. Deeper liquid carries waves faster, so the same note draws a larger pattern.
  viscosity: f32, // @default 0.5 Damps short waves harder than long ones. Water near 0.2, oil near 0.6, honey at 1.
  tension: f32, // @default 0.4 Surface tension: stiffens the short ripples.
  radius: f32, // @default 0.47 Dish radius as a share of the grid.
  lobes: f32, // @default 7 Bulges around the vessel's wall. The vessel's shape picks the pattern's symmetry; 0 is round.
  lobeDepth: f32, // @default 0.03 How far the bulges stand out, as a share of the radius.
  shape: f32, // @default 0 The vessel: 0 round (with lobes), 1 circle, 2 square, 3 hexagon.
  squareness: f32, // @default 0 0 a round dish, 1 a square plate (Chladni's figures).
  dishSize: f32, // @default 0.55 The dish's size against the sound: a smaller dish draws the same note larger, so high notes stay readable.
  calm: f32, // @default 0 Extra damping, 0..1: a hand laid flat on the water.
};
${SIM_BINDINGS}
${SIM_COMMON}

/** Advance a stored phase by step cycles, wrapping at wrap, and split it into its two halves. */
fn advance(cell: vec4f, step: f32, wrap: f32) -> vec4f {
  var phase = phaseOf(cell) + step;
  phase = phase - wrap * floor(phase / wrap);
  let high = floor(phase * 256.0) / 256.0;
  return vec4f(high, phase - high, 0.0, 0.0);
}

/** The drive signal at these phases: r is the shaking (cosine), g the rim (sine). Peak 1. */
fn signal(fundamental: f32, tonePhase: f32) -> vec2f {
  let norm = 1.0 + params.harmonic2 + params.harmonic3 + params.tone;
  let a = TAU * fundamental;
  let b = TAU * tonePhase;
  let shake = cos(a) + params.harmonic2 * cos(2.0 * a) + params.harmonic3 * cos(3.0 * a) + params.tone * cos(b);
  let rim = sin(a) + params.harmonic2 * sin(2.0 * a) + params.harmonic3 * sin(3.0 * a) + params.tone * sin(b);
  return vec2f(shake, rim) / norm;
}

/** Height here, or the asking cell's own height across a wall (no flux through the wall). */
fn heightOr(p: vec2i, fallback: f32, radius: f32) -> f32 {
  if (wet(p, radius)) { return at(p).r; }
  return fallback;
}

fn pressure(p: vec2i, gravity: f32, sigma: f32, radius: f32) -> f32 {
  let h = at(p).r;
  let curvature = heightOr(p + vec2i(1, 0), h, radius) + heightOr(p - vec2i(1, 0), h, radius)
    + heightOr(p + vec2i(0, 1), h, radius) + heightOr(p - vec2i(0, 1), h, radius) - 4.0 * h;
  return gravity * h - sigma * curvature;
}

/** The pressure difference across the face from p along axis; none across a wall. */
fn gradientAcross(p: vec2i, axis: vec2i, gravity: f32, sigma: f32, radius: f32) -> f32 {
  if (!(wet(p, radius) && wet(p + axis, radius))) { return 0.0; }
  return pressure(p + axis, gravity, sigma, radius) - pressure(p, gravity, sigma, radius);
}

/** A face velocity, or the given value where that face is a wall (free slip). */
fn faceOr(p: vec2i, axis: vec2i, channel: i32, fallback: f32, radius: f32) -> f32 {
  if (wet(p, radius) && wet(p + axis, radius)) {
    let c = at(p);
    return select(c.b, c.g, channel == 0);
  }
  return fallback;
}

/** One face's update. axis is the face's direction, channel 0 for u and 1 for v. */
fn stepFace(p: vec2i, axis: vec2i, channel: i32, gravity: f32, sigma: f32, radius: f32) -> f32 {
  if (!wet(p + axis, radius)) { return 0.0; }
  let here = at(p);
  let u = select(here.b, here.g, channel == 0);
  let side = vec2i(axis.y, axis.x);
  // Pressure gradient across the face, smoothed 1:10:1 across it. With the plain divergence
  // that makes the wave operator the isotropic nine-point Laplacian: the five-point one
  // carries waves a little faster along the grid than across it, and the Faraday instability
  // is selective enough to lock its pattern to the grid's axes.
  let push = -(gradientAcross(p, axis, gravity, sigma, radius) * (10.0 / 12.0)
    + (gradientAcross(p + side, axis, gravity, sigma, radius) + gradientAcross(p - side, axis, gravity, sigma, radius)) * (1.0 / 12.0));
  // Viscosity: the face's Laplacian.
  let ua = faceOr(p + axis, axis, channel, u, radius);
  let ub = faceOr(p - axis, axis, channel, u, radius);
  let uc = faceOr(p + side, axis, channel, u, radius);
  let ud = faceOr(p - side, axis, channel, u, radius);
  let nu = params.viscosity * 0.12;
  let diffuse = nu * (ua + ub + uc + ud - 4.0 * u);
  // Self-advection, upwind: the flow carries its own momentum.
  let otherChannel = 1 - channel;
  let cross = 0.25 * (
    faceOr(p, side, otherChannel, 0.0, radius) + faceOr(p + axis, side, otherChannel, 0.0, radius)
    + faceOr(p - side, side, otherChannel, 0.0, radius) + faceOr(p + axis - side, side, otherChannel, 0.0, radius));
  let along = select(ua - u, u - ub, u > 0.0);
  let across = select(uc - u, u - ud, cross > 0.0);
  let carry = u * along + cross * across;
  // Bottom friction, the hand on the water, and a quadratic drag that saturates the pattern.
  let damping = 0.0008 + params.calm * 0.05;
  let next = u + push + diffuse - carry - damping * u - 3.0 * abs(u) * u;
  return clamp(next, -0.4, 0.4);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = vec2i(uv * vec2f(size()));
  let radius = params.radius * f32(size().x);
  if (isBook(p)) {
    let step = params.frequency * TIME_SCALE * params.dishSize;
    // The fundamental wraps at TWO cycles: the Faraday response is at half the drive, so one
    // of its cycles is two of the drive's, and the surface shader needs to tell them apart.
    let fundamental = advance(at(vec2i(0, 0)), step, 2.0);
    let second = advance(at(vec2i(1, 0)), step * params.toneRatio, 1.0);
    if (p.x == 0) { return fundamental; }
    if (p.x == 1) { return second; }
    return vec4f(signal(phaseOf(fundamental), phaseOf(second)), 0.0, 0.0);
  }
  if (!wet(p, radius)) { return vec4f(0.0); }
  let here = at(p);
  let shake = at(vec2i(2, 0)).r;
  let gravity = mix(0.03, 0.15, clamp(params.depth, 0.0, 1.0)) * (1.0 + clamp(params.drive, 0.0, 0.95) * shake);
  let sigma = clamp(params.tension, 0.0, 1.0) * 0.004;
  let u = stepFace(p, vec2i(1, 0), 0, gravity, sigma, radius);
  let v = stepFace(p, vec2i(0, 1), 1, gravity, sigma, radius);
  return vec4f(here.r, u, v, here.a);
}
`;

/** The surface from the new velocities: what flows out of a cell lowers it. */
export const CYMATICS_HEIGHT_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  radius: f32, // @default 0.47 Dish radius as a share of the grid. Keep it equal to the momentum pass's.
  lobes: f32, // @default 7 The vessel's bulges. Keep it equal to the momentum pass's.
  lobeDepth: f32, // @default 0.03 How far they stand out. Keep it equal to the momentum pass's.
  shape: f32, // @default 0 The vessel. Keep it equal to the momentum pass's.
  squareness: f32, // @default 0 Round to square. Keep it equal to the momentum pass's.
  rim: f32, // @default 1 Meniscus waves: how hard the shaking wall pumps waves inward at the drive frequency.
  rimFocus: f32, // @default 1 How much the pumping gathers at the vessel's bulges: 0 even all round (rings), 1 a ring of separate sources (petals and islands).
  splash: f32, // @default 0 A drop falling on the surface, 0..1, while it is held up.
  splashSeed: f32, // @default 0 Which drop: each new whole number lands somewhere else.
  noise: f32, // @default 0.05 The thermal stir the Faraday waves grow out of.
};
${SIM_BINDINGS}
${SIM_COMMON}

/** Depth at a face: the mean of its two cells, never dry. */
fn faceDepth(a: f32, b: f32) -> f32 { return max(1.0 + 0.5 * (a + b), 0.05); }

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = vec2i(uv * vec2f(size()));
  let here = at(p);
  if (isBook(p)) { return here; }
  let radius = params.radius * f32(size().x);
  if (!wet(p, radius)) { return vec4f(0.0); }
  let h = here.r;
  let east = at(p + vec2i(1, 0));
  let west = at(p - vec2i(1, 0));
  let north = at(p + vec2i(0, 1));
  let south = at(p - vec2i(0, 1));
  // A dry neighbour reads all zeros, so its face carries no flux and its height is ours.
  let he = select(h, east.r, wet(p + vec2i(1, 0), radius));
  let hw = select(h, west.r, wet(p - vec2i(1, 0), radius));
  let hn = select(h, north.r, wet(p + vec2i(0, 1), radius));
  let hs = select(h, south.r, wet(p - vec2i(0, 1), radius));
  let flux = faceDepth(h, he) * here.g - faceDepth(hw, h) * west.g
    + faceDepth(h, hn) * here.b - faceDepth(hs, h) * south.b;
  var dh = -flux;

  // The meniscus: a band one wavelength's sliver wide at the wall, pumped at the drive.
  let middle = centre();
  let toward = vec2f(p) + vec2f(0.5) - middle;
  let band = smoothstep(radius - 8.0, radius - 1.0, vesselReach(toward));
  // The meniscus pumps hardest where the wall bulges out (it climbs a convex wall further),
  // so a lobed vessel is a ring of sources rather than one: their waves cross in the dish
  // and draw the petals and islands, not only rings.
  let focus = 1.0 + params.rimFocus * cos(params.lobes * atan2(toward.y, toward.x));
  dh = dh + params.rim * 0.006 * at(vec2i(2, 0)).g * band * focus;

  // A drop: a crater ringed by a lip, zero net volume. Its spot is hashed from the seed.
  if (params.splash > 0.0) {
    let seed = floor(params.splashSeed);
    let angle = TAU * hash2(vec2f(seed, 7.3));
    let reach = 0.75 * sqrt(hash2(vec2f(seed, 2.9)));
    let spot = middle + radius * reach * vec2f(cos(angle), sin(angle));
    let d2 = dot(vec2f(p) - spot, vec2f(p) - spot);
    let crater = exp(-d2 / 50.0) - 0.25 * exp(-d2 / 200.0);
    dh = dh - params.splash * 0.01 * crater;
  }

  // Noise, too small to see, for the instability to grow from.
  dh = dh + params.noise * 1.0e-4 * (smoothNoise(vec2f(p) / 6.0 + vec2f(frameU.absFrame * 7.31, frameU.absFrame * 3.17)) - 0.5);

  // The level settles back: the shaking wall slowly piles liquid up near itself (wave
  // set-up), which leaves a dish-wide bowl that mirrors the ring lamp as giant arcs. A real
  // dish's bowl relaxes through the bulk flow this shallow model leaves out.
  dh = dh - 2.0e-4 * h;

  let next = clamp(h + dh, -0.8, 2.0);
  return vec4f(next, here.g, here.b, next - h);
}
`;

/**
 * THE CAMERA AND THE LAMPS.
 *
 * A liquid surface is a mirror, so a camera above it sees the LAMPS, reflected wherever the
 * surface is tilted just so. Flat water reflects the camera itself and stays black. A lamp
 * at elevation e lights the slopes tilted by (90 - e) / 2 towards it, so low lamps catch only
 * the steep flanks of the crests and each lamp colours the flanks that face it. The ring
 * lamps around the lens are what draw the fine zebra lines of the reference photograph:
 * every point whose slope matches the ring's angle lights up, which traces contour lines of
 * slope across every wave.
 *
 * THE SHUTTER. The surface oscillates at half the drive frequency, far faster than a frame,
 * so one frame's surface is one arbitrary instant. A photograph exposes over many cycles;
 * a stroboscope freezes one phase. The state carries dh, so each point's oscillation can be
 * recovered (for a standing wave at angular rate w, h and dh/w are the two quadratures) and
 * the surface rebuilt at any phase. `strobe` picks the phase relative to the drive's own
 * (stored in the state), so it holds still; drive it with time and the pattern moves in slow
 * motion. `shutter` opens the exposure over that share of a cycle, which smears each
 * highlight along its path: the streaks of a long exposure.
 *
 * Under the surface: the dish's dark floor, lit through the water. A crest focuses light
 * and a trough spreads it, so the floor shows the caustic of the surface's curvature.
 */
export const CYMATICS_SURFACE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  radius: f32, // @default 0.47 Dish radius as a share of the simulation grid. Keep it equal to the simulation's.
  lobes: f32, // @default 7 The vessel's bulges, as the simulation has them.
  lobeDepth: f32, // @default 0.03 How far they stand out.
  shape: f32, // @default 0 The vessel, as the simulation (or the plate) has it.
  squareness: f32, // @default 0 Round to square, as the simulation has it.
  frequency: f32, // @default 29.14 The drive frequency, so the shutter knows the surface's cycle.
  dishSize: f32, // @default 0.55 As the simulation has it.
  waveHeight: f32, // @default 1 Exaggerates the slopes the lamps see.
  shutter: f32, // @default 0.05 Exposure as a share of one wave cycle: 0 a strobe flash, 1 the whole cycle.
  strobe: f32, // @default 0 Which phase of the cycle the strobe catches, in turns. Drive it with time for slow motion.
  palette: f32, // @default 0 The lamp rig: 0 Cymascope, 1 Prism, 2 Ember, 3 Aurora, 4 Peacock, 5 Neon. Between two whole numbers it blends.
  rigTurn: f32, // @default 0 Turns the rig of coloured lamps around the dish, in turns.
  ring: f32, // @default 1.3 Ring lamps around the lens: the fine contour lines.
  rings: f32, // @default 7 Rows of LEDs in the ring lamp, 1 to 16. More rows, denser stripes.
  ringColour: f32, // @default 0.9 0 white rings; 1 each ring takes its own colour from the rig, so gentle and steep slopes differ.
  radial: f32, // @default 0 Recolours the dish centre to edge in the rig's colours.
  spots: f32, // @default 0.15 The six coloured lamps: faint by default, the ring lamp draws the figure.
  elevation: f32, // @default 60 Height of the coloured lamps above the horizon, in degrees. Lower lamps catch only the steepest flanks.
  caustics: f32, // @default 0.6 Light focused through the waves onto the dish's floor.
  exposure: f32, // @default 2 Overall exposure.
  tilt: f32, // @default 0 Camera tilt away from straight down, in degrees.
  orbit: f32, // @default 0 Camera heading around the dish, in degrees.
  zoom: f32, // @default 1 Camera zoom.
  flash: f32, // @default 0 A flash on the coloured lamps, 0..1 (the beat lane).
  shimmer: f32, // @default 0 Lamps warm towards white where the surface swings hardest.
  sand: f32, // @default 0 Sand on the plate: 0 none, 1 the grains alone under a raking light, over a darkened plate.
  sandTint: vec3f, // @default [1, 0.9, 0.74] The sand's colour.
  viewEye: vec3f, // @default [0, 3.7, 0.001] Viewport camera position.
  viewTarget: vec3f, // @default [0, 0, 0] Viewport camera target.
  viewFov: f32, // @default 36 Viewport field of view, degrees.
  viewOverride: f32, // @default 0 1 while the viewer's orbit camera is in charge.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
// The sand: grains drawn into the dish's own square by 'points_sand' (§T1714b).
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318531;
const TIME_SCALE: f32 = ${TIME_SCALE};
${VESSEL_WGSL}

/** Grains per texel, bilinear by hand (the texture is bound unfilterable). */
fn sandAt(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(inputTexture1));
  let p = uv * dims - vec2f(0.5);
  let i = vec2i(floor(p));
  let f = fract(p);
  let top = vec2i(dims) - vec2i(1);
  let a = textureLoad(inputTexture1, clamp(i, vec2i(0), top), 0).r;
  let b = textureLoad(inputTexture1, clamp(i + vec2i(1, 0), vec2i(0), top), 0).r;
  let c = textureLoad(inputTexture1, clamp(i + vec2i(0, 1), vec2i(0), top), 0).r;
  let d = textureLoad(inputTexture1, clamp(i + vec2i(1, 1), vec2i(0), top), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * The sand, lit from low on one side (warm) with a faint cool fill from the other: its density is a little heightmap, so a ridge of grains
 * catches the light on one flank and shades the other, the way Chladni figures are photographed.
 */
fn sandLight(uv: vec2f) -> vec4f {
  let step = 1.0 / vec2f(textureDimensions(inputTexture1));
  let h = sandAt(uv);
  let gx = sandAt(uv + vec2f(step.x, 0.0)) - sandAt(uv - vec2f(step.x, 0.0));
  let gy = sandAt(uv + vec2f(0.0, step.y)) - sandAt(uv - vec2f(0.0, step.y));
  let normal = normalize(vec3f(-gx * 0.1, 1.0, -gy * 0.1));
  let rake = normalize(vec3f(-0.62, 0.42, -0.66));
  let fill = normalize(vec3f(0.7, 0.3, 0.64));
  let lit = params.sandTint * (0.25 + 1.15 * max(dot(normal, rake), 0.0))
    + vec3f(0.35, 0.5, 0.75) * 0.45 * max(dot(normal, fill), 0.0);
  let cover = 1.0 - exp(-h * 0.25);
  return vec4f(lit * cover, cover);
}

/** Six rigs, six colours each: four lamps, the ring, the liquid's own tint. */
var<private> PALETTES: array<vec3f, 36> = array<vec3f, 36>(
  // 0 Cymascope: ice, cobalt, aqua and violet.
  vec3f(0.0, 0.6, 1.0), vec3f(0.0, 0.18, 1.0), vec3f(0.2, 1.0, 0.9), vec3f(0.45, 0.25, 1.0), vec3f(0.6, 0.88, 1.0), vec3f(0.0, 0.06, 0.16),
  // 1 Prism: the three primaries and amber.
  vec3f(1.0, 0.06, 0.04), vec3f(0.05, 1.0, 0.2), vec3f(0.1, 0.2, 1.0), vec3f(1.0, 0.6, 0.0), vec3f(0.9, 0.9, 1.0), vec3f(0.03, 0.03, 0.06),
  // 2 Ember: fire, gold and magenta.
  vec3f(1.0, 0.3, 0.0), vec3f(1.0, 0.04, 0.3), vec3f(1.0, 0.7, 0.05), vec3f(0.9, 0.05, 0.02), vec3f(1.0, 0.6, 0.25), vec3f(0.1, 0.02, 0.0),
  // 3 Aurora: green, cyan, violet, rose.
  vec3f(0.1, 1.0, 0.35), vec3f(0.0, 0.75, 1.0), vec3f(0.5, 0.1, 1.0), vec3f(1.0, 0.2, 0.65), vec3f(0.4, 1.0, 0.8), vec3f(0.0, 0.07, 0.06),
  // 4 Peacock: gold, emerald, cobalt, amber (the gold-and-blue dish).
  vec3f(1.0, 0.72, 0.25), vec3f(0.0, 0.85, 0.45), vec3f(0.1, 0.25, 1.0), vec3f(1.0, 0.5, 0.05), vec3f(1.0, 0.8, 0.4), vec3f(0.02, 0.03, 0.08),
  // 5 Neon: cyan centre to magenta edge.
  vec3f(1.0, 0.05, 0.8), vec3f(0.0, 0.7, 1.0), vec3f(0.35, 0.3, 1.0), vec3f(0.9, 0.1, 1.0), vec3f(0.5, 0.6, 1.0), vec3f(0.05, 0.0, 0.08),
);

fn rigColour(slot: i32) -> vec3f {
  let wrapped = params.palette - 6.0 * floor(params.palette / 6.0);
  let a = i32(floor(wrapped)) % 6;
  let b = (a + 1) % 6;
  let t = smoothstep(0.0, 1.0, fract(wrapped));
  return mix(PALETTES[a * 6 + slot], PALETTES[b * 6 + slot], t);
}

fn lampDirection(azimuth: f32, elevation: f32) -> vec3f {
  return vec3f(cos(elevation) * cos(azimuth), sin(elevation), cos(elevation) * sin(azimuth));
}

/** Everything the surface can mirror, seen along direction r (y is up). */
fn environment(r: vec3f, swing: f32, footprint: f32) -> vec3f {
  var light = vec3f(0.0);
  let turn = TAU * params.rigTurn;
  let azimuth = atan2(r.z, r.x);
  // The ring lamp: a wide annular softbox of LED rows around the lens, 4 to 34 degrees off
  // vertical. A slope tilted by half a row's angle mirrors that row, so the softbox lights
  // nearly every slope the waves make and its rows draw them as contour lines of slope: the
  // zebra stripes of the photographs. Rings sets how many rows; each row its own gel along
  // the rig's colours (gentle slopes one colour, steep ones another), a third of the hue
  // following the heading.
  let zenith = acos(clamp(r.y, -1.0, 1.0)) * 180.0 / PI;
  let around = fract((azimuth - turn) / TAU + 1.0) * 4.0;
  let lampA = i32(floor(around)) % 4;
  let facet = mix(rigColour(lampA), rigColour((lampA + 1) % 4), smoothstep(0.0, 1.0, fract(around)));
  let rows = clamp(params.rings, 1.0, 16.0);
  let share = clamp((zenith - 4.0) / 30.0, 0.0, 1.0);
  let envelope = smoothstep(2.5, 5.0, zenith) * (1.0 - smoothstep(30.0, 36.0, zenith));
  // Prefiltered: where the slope turns so fast that one pixel spans more than a fraction of a
  // row's cycle, the stripes fade to their own mean instead of aliasing into moire.
  let cycles = footprint / 30.0 * rows;
  let stripe = mix(pow(0.5 + 0.5 * cos(TAU * share * rows), 6.0), 0.2256, smoothstep(0.5, 1.1, cycles));
  let gel = mix(mix(rigColour(0), rigColour(2), share), facet, 0.35);
  let tint = mix(rigColour(4), gel, params.ringColour);
  light = light + tint * params.ring * 12.0 * envelope * (0.04 + stripe) * (1.0 - 0.4 * share);
  // Six coloured lamps a sixth of a turn apart, alternating between two heights.
  let warm = clamp(params.shimmer * swing, 0.0, 1.0);
  for (var i = 0; i < 6; i = i + 1) {
    let az = turn + f32(i) * TAU / 6.0 + 0.3;
    let el = radians(params.elevation + f32(i % 2) * 12.0);
    let facing = dot(r, lampDirection(az, el));
    let spot = smoothstep(cos(radians(4.0)), cos(radians(1.5)), facing);
    let tint = mix(rigColour(i % 4), vec3f(1.0), warm);
    light = light + tint * params.spots * (1.0 + 2.0 * params.flash) * 45.0 * spot;
  }
  return light;
}

fn state(uv: vec2f) -> vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
}

/**
 * The tone curve, applied to brightness alone so the lamps keep their colour: a per-channel
 * curve walks every bright highlight to white, which is what washed the first cut out. Only
 * light past the top of the curve bleeds towards white, the way film burns.
 */
fn toneMap(x: vec3f) -> vec3f {
  let luma = dot(x, vec3f(0.2126, 0.7152, 0.0722));
  if (luma <= 1e-6) { return vec3f(0.0); }
  let mapped = (luma * (2.51 * luma + 0.03)) / (luma * (2.43 * luma + 0.59) + 0.14);
  let c = x * (mapped / luma);
  let peak = max(c.r, max(c.g, c.b));
  let burn = smoothstep(1.0, 2.5, peak);
  return clamp(mix(c / max(peak, 1.0), vec3f(1.0), burn * 0.6), vec3f(0.0), vec3f(1.0));
}

struct Camera {
  eye: vec3f,
  forward: vec3f,
  right: vec3f,
  up: vec3f,
  spread: f32,
};

/** The camera: the dish lies in the xz plane, radius 1, y up. */
fn camera() -> Camera {
  var eye: vec3f;
  var aim = vec3f(0.0);
  var up: vec3f;
  var fov: f32;
  if (params.viewOverride > 0.5) {
    eye = params.viewEye;
    aim = params.viewTarget;
    fov = radians(params.viewFov);
    let look = normalize(aim - eye);
    up = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, -1.0), abs(look.y) > 0.99);
  } else {
    let t = radians(clamp(params.tilt, 0.0, 80.0));
    let o = radians(params.orbit);
    eye = (3.7 / max(params.zoom, 0.1)) * vec3f(sin(t) * cos(o), cos(t), sin(t) * sin(o));
    up = vec3f(-cos(t) * cos(o), sin(t), -cos(t) * sin(o));
    fov = radians(36.0);
  }
  let forward = normalize(aim - eye);
  let right = normalize(cross(forward, up));
  return Camera(eye, forward, right, cross(right, forward), tan(fov * 0.5));
}

/** The light arriving through one point of the frame, before the tone curve. */
fn radiance(cam: Camera, ndc: vec2f, exposures: i32, cellsPerPixel: f32) -> vec3f {
  let dir = normalize(cam.forward + (ndc.x * cam.right + ndc.y * cam.up) * cam.spread);
  if (dir.y > -1e-4) { return vec3f(0.0); }
  let hit = cam.eye + dir * (-cam.eye.y / dir.y);
  let d = hit.xz;
  // The liquid ends at the vessel's own wall, and fades into the dark before it: the
  // meniscus curls up there and mirrors nothing the camera can see.
  let r = vesselReach(d);
  if (r > 1.0) { return vec3f(0.0); }
  let view = normalize(cam.eye - hit);

  // The surface, sampled at the point under this pixel and its four neighbours.
  let texel = 1.0 / vec2f(textureDimensions(inputTexture));
  let suv = vec2f(0.5) + d * params.radius;
  let c = state(suv);
  let e = state(suv + vec2f(texel.x, 0.0));
  let w = state(suv - vec2f(texel.x, 0.0));
  let n = state(suv + vec2f(0.0, texel.y));
  let s = state(suv - vec2f(0.0, texel.y));

  // The strobe: the surface rebuilt at a fixed phase of the drive (see above).
  let rate = PI * params.frequency * TIME_SCALE * params.dishSize;
  let book = textureLoad(inputTexture, vec2i(0, 0), 0);
  let base = TAU * params.strobe - PI * (book.r + book.g);
  let swing = length(vec2f(c.r, c.a / rate)) * 12.0;
  let centreToEdge = mix(rigColour(1), rigColour(3), smoothstep(0.1, 0.95, r));
  let gain = 40.0 * params.waveHeight;
  let floorTint = rigColour(5);

  var colour = vec3f(0.0);
  for (var k = 0; k < exposures; k = k + 1) {
    let offset = base + params.shutter * TAU * ((f32(k) + 0.5) / f32(exposures) - 0.5);
    let q = vec2f(cos(offset), sin(offset) / rate);
    let hc = dot(vec2f(c.r, c.a), q);
    let he = dot(vec2f(e.r, e.a), q);
    let hw = dot(vec2f(w.r, w.a), q);
    let hn = dot(vec2f(n.r, n.a), q);
    let hs = dot(vec2f(s.r, s.a), q);
    let normal = normalize(vec3f(-(he - hw) * 0.5 * gain, 1.0, -(hn - hs) * 0.5 * gain));
    let mirrored = reflect(-view, normal);
    let facing = max(dot(normal, view), 0.0);
    let fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
    let curvature = (he + hw + hn + hs - 4.0 * hc) * gain;
    // How far the mirrored direction turns across one pixel, in degrees: the slope's own
    // change per simulation cell, times the cells a pixel spans.
    let bend = (abs(he - 2.0 * hc + hw) + abs(hn - 2.0 * hc + hs)) * gain * 114.6 * cellsPerPixel;
    let focus = clamp(1.0 - curvature * 6.0 * params.caustics, 0.0, 6.0);
    let below = floorTint * (0.01 + 0.12 * focus * params.caustics);
    colour = colour + fresnel * environment(mirrored, swing, bend) + (1.0 - fresnel) * below;
  }
  colour = colour / f32(exposures);
  // A gradient across the dish, centre to edge, in the rig's own colours: the light keeps its
  // brightness and takes the gradient's hue.
  let luma = dot(colour, vec3f(0.2126, 0.7152, 0.0722));
  colour = mix(colour, luma * centreToEdge / max(dot(centreToEdge, vec3f(0.2126, 0.7152, 0.0722)), 0.05), params.radial);
  if (params.sand > 0.0) {
    let grains = sandLight(suv);
    colour = mix(colour, colour * 0.06 + grains.rgb * 0.7, params.sand);
  }
  return colour * smoothstep(1.0, 0.9, r);
}

/** Four samples per pixel on a rotated grid: the contour lines are thinner than a pixel. */
const SUBPIXEL = array<vec2f, 4>(vec2f(0.125, 0.375), vec2f(-0.375, 0.125), vec2f(0.375, -0.125), vec2f(-0.125, -0.375));

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = frameU.resolution;
  let aspect = vec2f(res.x / res.y, 1.0);
  let cam = camera();
  // A strobe needs one look at the surface; an open shutter needs one per slice of the cycle.
  let exposures = 1 + i32(round(clamp(params.shutter, 0.0, 1.0) * 7.0));
  // Simulation cells under one pixel (straight down; a tilt only adds to it at the far side).
  let ground = 2.0 / res.y * cam.spread * length(cam.eye);
  let cellsPerPixel = ground * params.radius * f32(textureDimensions(inputTexture).x);
  var colour = vec3f(0.0);
  for (var i = 0; i < 4; i = i + 1) {
    let at = uv + SUBPIXEL[i] / res;
    let ndc = vec2f(at.x * 2.0 - 1.0, 1.0 - at.y * 2.0) * aspect;
    colour = colour + toneMap(radiance(cam, ndc, exposures, cellsPerPixel) * params.exposure);
  }
  return vec4f(colour * 0.25, 1.0);
}
`;

/**
 * THE INSTRUMENT PANEL, for when the dish is being shown rather than played: a bench
 * oscilloscope beside the dish, tracing the same sum of partials the dish is shaken with
 * (a fixed 125 ms time base triggered on the fundamental, or X-Y against the fundamental), and the drive frequency above it in seven segments. The beam is drawn as a
 * distance to the curve, so it is one continuous line at any size, with a phosphor bloom.
 * It sits in the frame's bottom-right corner, clear of the dish. `scope` 0 is a pass-through.
 */
export const CYMATICS_HUD_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  scope: f32, // @default 0 The instrument panel: 0 hidden, 1 shown. Between them it fades.
  frequency: f32, // @default 29.14 The drive frequency the readout shows, in hertz.
  harmonic2: f32, // @default 0 Second harmonic, as the dish is driven.
  harmonic3: f32, // @default 0 Third harmonic.
  toneRatio: f32, // @default 1.5 The second tone, as a multiple of the fundamental.
  tone: f32, // @default 0 The second tone's amplitude.
  xy: f32, // @default 0 0 a triggered time base, 1 X-Y against the fundamental.
  tint: vec3f, // @default [0.3, 1, 0.45] The phosphor's colour.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const TAU: f32 = 6.28318531;
/** Seconds across the scope's glass: 12.5 ms a division over ten. */
const TIMEBASE: f32 = 0.125;

/** The drive signal at fundamental phase theta (in turns): peak 1. */
fn wave(theta: f32) -> f32 {
  let drift = fract(params.toneRatio * params.frequency * frameU.absTime * 0.01);
  let a = TAU * theta;
  let norm = 1.0 + params.harmonic2 + params.harmonic3 + params.tone;
  return (cos(a) + params.harmonic2 * cos(2.0 * a) + params.harmonic3 * cos(3.0 * a)
    + params.tone * cos(TAU * (theta * params.toneRatio + drift))) / norm;
}

/** Where the beam is at curve parameter s (0..1), in the screen's own 0..1 square. */
fn beamAt(s: f32) -> vec2f {
  if (params.xy > 0.5) {
    let theta = s * 4.0;
    return vec2f(0.5 + 0.36 * cos(TAU * theta), 0.5 - 0.36 * wave(theta));
  }
  // A fixed time base, as a bench scope has: TIMEBASE seconds across the glass, so the cycles
  // on screen follow the frequency (one at 8 Hz, nine at 70) instead of a period-locked two.
  return vec2f(0.04 + 0.92 * s, 0.5 - 0.36 * wave(s * params.frequency * TIMEBASE));
}

/** Distance to a segment from a to b. */
fn segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

/** Seven segments in a cell 1 wide and 2 tall, lit by the bits of mask (a=1 … g=64). */
fn sevenSegments(p: vec2f, mask: u32) -> f32 {
  var d = 1e3;
  let ends = array<vec4f, 7>(
    vec4f(0.1, 2.0, 0.9, 2.0), vec4f(1.0, 1.9, 1.0, 1.1), vec4f(1.0, 0.9, 1.0, 0.1),
    vec4f(0.1, 0.0, 0.9, 0.0), vec4f(0.0, 0.9, 0.0, 0.1), vec4f(0.0, 1.9, 0.0, 1.1),
    vec4f(0.1, 1.0, 0.9, 1.0));
  for (var i = 0u; i < 7u; i = i + 1u) {
    if ((mask & (1u << i)) != 0u) {
      let e = ends[i];
      d = min(d, segment(p, e.xy, e.zw));
    }
  }
  return d;
}

const DIGITS = array<u32, 10>(63u, 6u, 91u, 79u, 102u, 109u, 125u, 7u, 127u, 111u);

/** The readout "123.45 Hz", right-aligned at the origin; p in units of one cell's width. */
fn readout(p: vec2f, value: f32) -> f32 {
  let hundredths = u32(round(clamp(value, 0.0, 9999.99) * 100.0));
  var d = 1e3;
  // "Hz", then the digits leftward with the point before the last two.
  // A lowercase z: two bars and the diagonal, the lower half of a cell.
  let z = p - vec2f(-1.2, 0.0);
  d = min(d, min(segment(z, vec2f(0.1, 1.0), vec2f(0.9, 1.0)), min(segment(z, vec2f(0.9, 1.0), vec2f(0.1, 0.0)), segment(z, vec2f(0.1, 0.0), vec2f(0.9, 0.0)))));
  d = min(d, sevenSegments(p - vec2f(-2.6, 0.0), 118u));
  var rest = hundredths;
  var x = -4.6;
  for (var place = 0; place < 6; place = place + 1) {
    if (place == 2) {
      d = min(d, length(p - vec2f(x + 1.0, 0.0)));
      x = x - 0.5;
    }
    if (place > 2 && rest == 0u) { break; }
    d = min(d, sevenSegments(p - vec2f(x, 0.0), DIGITS[rest % 10u]));
    rest = rest / 10u;
    x = x - 1.5;
  }
  return d;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let show = clamp(params.scope, 0.0, 1.0);
  if (show <= 0.0) { return vec4f(base.rgb, 1.0); }
  let res = frameU.resolution;
  let h = res.y;
  let px = uv * res;
  let pixel = 1.0 / h;
  // The screen: the bottom-right corner, clear of the dish.
  let lo = vec2f(res.x - 0.37 * h, 0.74 * h);
  let hi = vec2f(res.x - 0.05 * h, 0.95 * h);
  var colour = base.rgb;
  let size = (hi - lo) * 0.5;
  let middle = (hi + lo) * 0.5;
  let radius = 0.01 * h;
  let q = abs(px - middle) - size + vec2f(radius);
  let box = (length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius) / h;
  if (box < 0.0) {
    let local = (px - lo) / (hi - lo);
    let span = (hi - lo) / h;
    // The graticule, hairline: ten by six divisions, the centre axes a touch brighter and
    // ticked in fifths of a division, the way a bench scope's glass is etched.
    let cellSize = span / vec2f(10.0, 6.0);
    let grid = abs(fract(local * vec2f(10.0, 6.0) + vec2f(0.5)) - vec2f(0.5)) * cellSize;
    let axis = abs(local - vec2f(0.5)) * span;
    let tick = abs(fract(local * vec2f(50.0, 30.0) + vec2f(0.5)) - vec2f(0.5)) * span / vec2f(50.0, 30.0);
    let hair = 0.7 * pixel;
    var etch = 0.018 * smoothstep(hair, 0.0, min(grid.x, grid.y));
    etch = etch + 0.035 * smoothstep(hair, 0.0, min(axis.x, axis.y));
    etch = etch + 0.04 * smoothstep(hair, 0.0, tick.x) * step(axis.y, 0.006 * h * pixel);
    etch = etch + 0.04 * smoothstep(hair, 0.0, tick.y) * step(axis.x, 0.006 * h * pixel);
    // The beam: the nearest stretch of the curve, in pixels. Time base: the curve is a
    // function of x, so only the segments near this column count. X-Y: all of them.
    let aspect = span.x / span.y;
    var nearest = 1e3;
    if (params.xy > 0.5) {
      var prev = beamAt(0.0);
      for (var k = 1; k <= 240; k = k + 1) {
        let next = beamAt(f32(k) / 240.0);
        nearest = min(nearest, segment(local * vec2f(aspect, 1.0), prev * vec2f(aspect, 1.0), next * vec2f(aspect, 1.0)));
        prev = next;
      }
    } else {
      let around = (local.x - 0.04) / 0.92;
      var prev = beamAt(around - 0.07);
      for (var k = 1; k <= 70; k = k + 1) {
        let next = beamAt(around - 0.07 + f32(k) * 0.002);
        nearest = min(nearest, segment(local * vec2f(aspect, 1.0), prev * vec2f(aspect, 1.0), next * vec2f(aspect, 1.0)));
        prev = next;
      }
    }
    let ink = nearest * span.y;
    let core = smoothstep(1.6 * pixel, 0.5 * pixel, ink);
    let beam = core + 0.35 * exp(-ink / (2.5 * pixel)) + 0.12 * exp(-ink / (9.0 * pixel));
    // Dark glass, faintly lifted towards its centre.
    let glass = vec3f(0.006, 0.014, 0.01) * (1.4 - 0.8 * length(local - vec2f(0.5)));
    colour = mix(colour, glass, 0.92 * show);
    colour = colour + show * (params.tint * (etch + beam) + vec3f(0.55) * core);
  }
  // The bezel: one hairline.
  colour = colour + show * 0.12 * params.tint * smoothstep(0.9 * pixel, 0.0, abs(box));
  // The readout above the screen, right-aligned with it: thin segments, a little glow.
  let cell = 0.016 * h;
  let p = vec2f(px.x - hi.x + 0.004 * h, lo.y - 0.022 * h - px.y) / cell;
  let d = readout(p, params.frequency) * cell / h;
  colour = colour + show * params.tint * (0.9 * smoothstep(1.3 * pixel, 0.4 * pixel, d) + 0.12 * exp(-d / (3.0 * pixel)));
  return vec4f(colour, 1.0);
}
`;

/**
 * THE PLATE (§T1713b): a vibrating plate under the same lamps, its figure computed as a sum of
 * the shape's own modes rather than simulated. A plate's figure is its forced response,
 * Σ φᵢ(x) φᵢ(r₀) / (kᵢ² − k² + iηk²) (Tuan et al. 2015): near a resonance one mode dominates and
 * the figure is crisp; between resonances neighbouring modes mix and it smears. Those resonances
 * are the plate's mode spots. A plate obeys Chladni's law, frequency ∝ k², so the wavenumber is
 * k = plateScale·√f.
 *
 * Two passes. `CYMATICS_PLATE_MODES_WGSL` keeps one texel per mode (its complex amplitude) in a
 * Feedback loop and relaxes it toward the forced response each frame, so a sweep rings into the
 * next figure instead of cutting to it. `CYMATICS_PLATE_FIELD_WGSL` sums the modes into the
 * liquid's own state layout (height in r, its quadrature in a), so the strobe, the lamps, the
 * palettes and the instrument panel read a plate exactly as they read the liquid.
 *
 * The drive: a ring of `symmetry` sources at `driveRadius` on the circle (so only modes whose m
 * is a multiple of it sound, and the figure has that symmetry), a point `driveRadius` out along
 * the diagonal on the square, along the edge normal on the hexagon. At the centre, a circle
 * sounds only its rings and a square only its ψ+ modes with both orders even.
 */
const PLATE_COMMON = `
${PLATE_TABLES_WGSL}

fn row(shape: i32, i: u32) -> vec4f {
  if (shape == 2) { return SQUARE[min(i, SQUARE_MODES - 1u)]; }
  if (shape == 3) { return HEXAGON[min(i, HEXAGON_MODES - 1u)]; }
  return CIRCLE[min(i, CIRCLE_MODES - 1u)];
}

fn modeCount(shape: i32) -> u32 {
  if (shape == 2) { return SQUARE_MODES; }
  if (shape == 3) { return HEXAGON_MODES; }
  return CIRCLE_MODES;
}

fn modeK(shape: i32, r: vec4f) -> f32 {
  if (shape == 1 || shape == 0) { return r.y; }
  return r.w;
}

/**
 * Bessel J_m(x) by Miller's backward recurrence, normalised with J0 + 2(J2 + J4 + …) = 1. No
 * trigonometry, and exact to float precision for the m and x a plate reaches.
 */
fn besselJ(m: i32, x: f32) -> f32 {
  if (x < 1e-4) { return select(0.0, 1.0, m == 0); }
  let top = 2 * ((max(m, i32(x)) + 18) / 2);
  var next = 0.0;
  var here = 1e-20;
  var norm = 0.0;
  var wanted = 0.0;
  for (var k = top; k > 0; k = k - 1) {
    let below = (2.0 * f32(k) / x) * here - next;
    next = here;
    here = below;
    if (k - 1 == m) { wanted = here; }
    if ((k - 1) % 2 == 0 && k - 1 > 0) { norm = norm + 2.0 * here; }
    if (abs(here) > 1e18) {
      here = here * 1e-18; next = next * 1e-18; norm = norm * 1e-18; wanted = wanted * 1e-18;
    }
  }
  norm = norm + here;
  return wanted / norm;
}

/** Mode i of the shape at d (dish units). */
fn modeAt(shape: i32, r: vec4f, d: vec2f) -> f32 {
  if (shape == 2) {
    let u = (d + vec2f(SQUARE_HALF)) / (2.0 * SQUARE_HALF);
    let pi = 3.14159265;
    return cos(r.x * pi * u.x) * cos(r.y * pi * u.y) + r.z * cos(r.y * pi * u.x) * cos(r.x * pi * u.y);
  }
  if (shape == 3) {
    var sum = 0.0;
    for (var j = 0; j < 6; j = j + 1) {
      let angle = f32(j) * 1.04719755;
      let c = cos(angle);
      let s = sin(angle);
      let k1 = vec2f(c * r.x - s * r.y, s * r.x + c * r.y);
      let k2 = vec2f(c * r.x + s * r.y, s * r.x - c * r.y);
      sum = sum + cos(dot(k1, d)) + cos(dot(k2, d));
    }
    return sum / 12.0;
  }
  let m = i32(r.x);
  return besselJ(m, r.y * length(d)) * cos(f32(m) * atan2(d.y, d.x));
}
`;

/** One texel per mode: its complex amplitude, relaxing toward the forced response. */
export const CYMATICS_PLATE_MODES_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  shape: f32, // @default 1 The plate: 1 circle, 2 square, 3 hexagon, 4 Faraday lattice (no modes; 0 reads as a circle).
  frequency: f32, // @default 29.14 The drive frequency, in hertz.
  plateScale: f32, // @default 2.9 Wavenumber per square root of a hertz: the plate's size and stiffness against the sound.
  damping: f32, // @default 0.005 How sharp the resonances are: small, each mode spot is crisp and narrow; large, neighbouring modes blend.
  symmetry: f32, // @default 6 The circle's drive: this many sources in a ring, so the figure has this symmetry.
  driveRadius: f32, // @default 0.6 Where the drive sits, as a share of the radius: the ring's radius, or the point's distance from the centre.
  settle: f32, // @default 0.06 How fast the plate rings into a new figure, per frame.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
const SQUARE_HALF: f32 = ${SQUARE_HALF};
const HEX_APOTHEM: f32 = ${HEX_APOTHEM};
${PLATE_COMMON}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let i = u32(uv.x * f32(textureDimensions(inputTexture).x));
  let previous = textureLoad(inputTexture, vec2i(i32(i), 0), 0);
  let shape = i32(round(params.shape));
  var aim = vec2f(0.0);
  if (shape < 4 && i < modeCount(shape)) {
    let r = row(shape, i);
    let ki = modeK(shape, r);
    let k = params.plateScale * sqrt(max(params.frequency, 0.0));
    var coupling = 0.0;
    if (shape == 2) {
      // Four points on the diagonals, so the drive keeps the square's own symmetry.
      let q = params.driveRadius * SQUARE_HALF * 0.7071;
      coupling = 0.25 * (modeAt(shape, r, vec2f(q, q)) + modeAt(shape, r, vec2f(-q, q))
        + modeAt(shape, r, vec2f(q, -q)) + modeAt(shape, r, vec2f(-q, -q)));
    } else if (shape == 3) {
      // The hexagon's modes are D6 already: one point stands for its six images.
      coupling = modeAt(shape, r, vec2f(params.driveRadius * HEX_APOTHEM, 0.0));
    } else {
      let m = i32(r.x);
      let ring = max(round(params.symmetry), 1.0);
      let locked = (m % i32(ring)) == 0;
      // Normalised modes (∫φ² = 1 over the disc): a high-m mode lives near the rim and is small
      // in value where a ring mode is large, so without the norm the rings drown every petal.
      let fm = f32(m);
      let norm2 = 1.5707963 * max(1.0 - fm * fm / (ki * ki), 1e-3) * pow(besselJ(m, ki), 2.0) * select(1.0, 2.0, m == 0);
      coupling = select(0.0, besselJ(m, ki * params.driveRadius), locked) / max(norm2, 1e-6);
    }
    let a = ki * ki - k * k;
    let b = max(params.damping, 1e-4) * k * k;
    aim = coupling * b * vec2f(a, -b) / (a * a + b * b);
  }
  let next = mix(previous.xy, aim, clamp(params.settle, 0.0, 1.0));
  return vec4f(next, 0.0, 1.0);
}
`;

/** The plate's figure, in the liquid's state layout: height in r, its quadrature in a. */
export const CYMATICS_PLATE_FIELD_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  shape: f32, // @default 1 The plate, as the modes pass has it.
  radius: f32, // @default 0.47 The dish radius as a share of the grid, as the liquid has it.
  lobes: f32, // @default 7 Unused by a plate (the round vessel's lobes).
  lobeDepth: f32, // @default 0.03 Unused by a plate.
  squareness: f32, // @default 0 Unused by a plate.
  amplitude: f32, // @default 0.03 How high the plate's figure stands, in the liquid's height units.
  frequency: f32, // @default 29.14 The drive frequency, so the quadrature matches the strobe's.
  dishSize: f32, // @default 0.55 As the surface has it, for the same reason.
  plateScale: f32, // @default 2.9 Wavenumber per square root of a hertz (the lattice uses it directly).
  symmetry: f32, // @default 12 The lattice's order: 12 for the 4:5 quasipattern, 6 for hexagons, 8 or 10 for the metastable ones.
  second: f32, // @default 0 The second ring's weight (the second tone): superlattices.
  secondRatio: f32, // @default 1.25 The second ring's wavenumber against the first's.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
const TIME_SCALE: f32 = ${TIME_SCALE};
${VESSEL_WGSL}
${PLATE_COMMON}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let d = (uv - vec2f(0.5)) / params.radius;
  let shape = i32(round(params.shape));
  if (vesselReach(d) > 1.0) { return vec4f(0.0); }
  let rate = 3.14159265 * params.frequency * TIME_SCALE * params.dishSize;
  if (shape >= 4) {
    // THE FARADAY LATTICE: the measured end state of the two-frequency Faraday experiments,
    // a standing superposition of plane waves whose wavevectors sit evenly on a circle (12 for
    // Edwards & Fauve's 4:5 quasipattern), plus a second ring turned half a step for the
    // superlattices (Kudrolli, Pier & Gollub's 6:7), sharpened by the quadratic term that makes
    // hexagons point one way. Our shallow-water liquid lacks the nonlinearity that selects
    // these states, so the plate draws them directly.
    let order = max(round(params.symmetry), 2.0);
    // Three times the plate's wavenumber: a quasipattern only shows itself across many
    // wavelengths; with a few, the twelve waves sum to a Bessel target at the centre.
    let k = 3.0 * params.plateScale * sqrt(max(params.frequency, 0.0));
    var h = 0.0;
    var hq = 0.0;
    for (var j = 0; j < 24; j = j + 1) {
      if (f32(j) >= order) { break; }
      let angle = 3.14159265 * f32(j) / order;
      let u = vec2f(cos(angle), sin(angle));
      h = h + cos(k * dot(u, d));
      let v = vec2f(cos(angle + 3.14159265 / (2.0 * order)), sin(angle + 3.14159265 / (2.0 * order)));
      hq = hq + cos(k * params.secondRatio * dot(v, d));
    }
    var field = (h + params.second * hq) / (order * (1.0 + params.second));
    field = field + 0.6 * field * field;
    return vec4f(field * params.amplitude * 2.0, 0.0, 0.0, 0.0);
  }
  var z = vec2f(0.0);
  let count = modeCount(shape);
  for (var i = 0u; i < count; i = i + 1u) {
    let c = textureLoad(inputTexture, vec2i(i32(i), 0), 0).xy;
    if (abs(c.x) + abs(c.y) < 2e-3) { continue; }
    z = z + c * modeAt(shape, row(shape, i), d);
  }
  // Normalised by the modes' total amplitude, so every shape and every figure stands the
  // same height under the lamps; the shape of the figure, not its loudness, is the subject.
  var total = 0.0;
  for (var i = 0u; i < count; i = i + 1u) {
    let c = textureLoad(inputTexture, vec2i(i32(i), 0), 0).xy;
    total = total + dot(c, c);
  }
  z = z / (sqrt(total) + 1e-3);
  return vec4f(z.x * params.amplitude, 0.0, 0.0, z.y * params.amplitude * rate);
}
`;

/** Texels in the plate's mode-amplitude texture. */
export const CYMATICS_PLATE_SLOTS = PLATE_MODE_SLOTS;

/** Grains per sand kernel: a Point Kernel holds at most a million (§T1714b). */
export const CYMATICS_SAND_CAPACITY = 1000000;
/** Sand kernels, each its own million grains; their pictures sum into one sand texture. */
export const CYMATICS_SAND_KERNELS = 4;
/** The sand texture's side: grains are drawn into the dish's own square, not the frame. */
export const CYMATICS_SAND_SIZE = 2048;

export const CYMATICS_SAND_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "grain", type: "vec4f", default: [0, 0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
]);

/**
 * SAND ON THE PLATE (§T1714b). Grabec & Sok (2023): each vibration cycle a grain makes one
 * random hop whose size is proportional to the plate's vibration under it, A(r) G with G a unit
 * Gaussian. Where the plate stands still (the nodal lines) a grain stops hopping, so the sand
 * diffuses out of the antinodes and gathers on the nodes, in about a thousand cycles. A drift
 * down the gradient of A² hastens it. Fine powder does the opposite (Faraday 1831; van Gerner
 * 2010, below 1 g): it collects at the antinodes, so `powder` turns the drift around.
 *
 * `grain` is the grain's own state, in dish units: xy its place on the plate, z 1 once it has
 * been scattered, w a fixed per-grain shade. `position` is where it is drawn: the field's own
 * square, so the sand texture lines up with the plate's field texel for texel.
 */
export const CYMATICS_SAND_KERNEL = `struct Params {
  shape: f32, // @default 1 The plate, as the modes pass has it.
  radius: f32, // @default 0.47 The dish radius as a share of the field grid.
  lobes: f32, // @default 7 The round vessel's lobes.
  lobeDepth: f32, // @default 0.03 How far they stand out.
  squareness: f32, // @default 0 Round to square.
  amplitude: f32, // @default 0.12 The plate field's amplitude, so A reads 1 at a strong antinode.
  rate: f32, // @default 0.02 The field's quadrature scale (π f TIME_SCALE dishSize), to rebuild the envelope.
  agitation: f32, // @default 1 How hard the grains hop where the plate moves.
  powder: f32, // @default 0 0 sand (gathers on the still lines), 1 fine powder (gathers where it moves most).
  scatter: f32, // @default 0 Above 0.5, every grain is thrown back across the plate.
  slot: f32, // @default 0 Which million this node holds: each kernel's grains draw from their own random stream.
};
const SQUARE_HALF: f32 = ${SQUARE_HALF};
const HEX_APOTHEM: f32 = ${HEX_APOTHEM};
fn reach(d: vec2f) -> f32 {
  let shape = i32(round(ctx_params_shape));
  if (shape == 1) { return length(d); }
  if (shape == 2) { return max(abs(d.x), abs(d.y)) / SQUARE_HALF; }
  if (shape == 3) {
    return max(abs(d.x), max(abs(0.5 * d.x + 0.8660254 * d.y), abs(-0.5 * d.x + 0.8660254 * d.y))) / HEX_APOTHEM;
  }
  let n = mix(2.0, 14.0, clamp(ctx_params_squareness, 0.0, 1.0));
  let a = abs(d) + vec2f(1e-6);
  let m = max(a.x, a.y);
  return m * pow(pow(a.x / m, n) + pow(a.y / m, n), 1.0 / n) / (1.0 + ctx_params_lobeDepth * cos(ctx_params_lobes * atan2(d.y, d.x)));
}
var<private> ctx_params_shape: f32;
var<private> ctx_params_squareness: f32;
var<private> ctx_params_lobes: f32;
var<private> ctx_params_lobeDepth: f32;
fn clipOf(d: vec2f, radius: f32) -> vec3f { return vec3f(2.0 * radius * d.x, -2.0 * radius * d.y, 0.0); }
fn envelope(d: vec2f, radius: f32, amplitude: f32, rate: f32) -> f32 {
  let f = fieldAt(clipOf(d, radius));
  return length(vec2f(f.r, f.a / max(rate, 1e-6))) / max(amplitude, 1e-6);
}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  ctx_params_shape = ctx.params.shape;
  ctx_params_squareness = ctx.params.squareness;
  ctx_params_lobes = ctx.params.lobes;
  ctx_params_lobeDepth = ctx.params.lobeDepth;
  var g = q.grain;
  let id = ctx.index + u32(ctx.params.slot) * 1000003u;
  if (g.z < 0.5 || ctx.params.scatter > 0.5) {
    let angle = 6.2831853 * pointRand(id, 11u + ctx.absFrame);
    let reachOut = sqrt(pointRand(id, 23u + ctx.absFrame)) * 1.1;
    g = vec4f(reachOut * cos(angle), reachOut * sin(angle), 1.0, pointRand(id, 5u));
  }
  var d = g.xy;
  let cell = 1.0 / (512.0 * ctx.params.radius);
  for (var hop = 0u; hop < 6u; hop = hop + 1u) {
    let a = envelope(d, ctx.params.radius, ctx.params.amplitude, ctx.params.rate);
    // One random hop, Box-Muller from the grain's own stream.
    let u1 = max(pointRand(id, ctx.absFrame * 16u + hop * 2u + 101u), 1e-6);
    let u2 = pointRand(id, ctx.absFrame * 16u + hop * 2u + 102u);
    let gauss = sqrt(-2.0 * log(u1)) * vec2f(cos(6.2831853 * u2), sin(6.2831853 * u2));
    // The drift down (sand) or up (powder) the slope of A².
    let ex = envelope(d + vec2f(cell, 0.0), ctx.params.radius, ctx.params.amplitude, ctx.params.rate);
    let ey = envelope(d + vec2f(0.0, cell), ctx.params.radius, ctx.params.amplitude, ctx.params.rate);
    let slope = vec2f(ex * ex - a * a, ey * ey - a * a) / cell;
    let sign = mix(-1.0, 1.0, clamp(ctx.params.powder, 0.0, 1.0));
    d = d + ctx.params.agitation * (0.006 * a * gauss + sign * 0.00006 * slope);
    // The wall: a grain that hops out lands back just inside it.
    let out = reach(d);
    if (out > 0.985) { d = d * (0.985 / out); }
  }
  q.grain = vec4f(d, 1.0, g.w);
  q.position = clipOf(d, ctx.params.radius);
  let shade = 0.35 + 0.65 * g.w;
  q.tint = vec4f(shade, shade, shade, 1.0);
  return q;
}`;
