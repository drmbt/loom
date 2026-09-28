import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1486b — E80 AZULEJO: the three stand-ins that let the file show its idea with no media
 * and no camera.
 *
 * The example is a compositing rig — an OUTER picture, an INNER picture, and a person-shaped
 * mask choosing between them — and every one of the three is a Switch whose first input is
 * one of these shaders. They are understudies, not the point: a Movie File In or the webcam
 * path replaces each one with a change of index. What they have to be is GOOD ENOUGH TO READ
 * AS THE REFERENCE (a projection on the Pavilhão de Portugal: blue-and-white tiles, two
 * people's silhouettes cut out of them, Lisbon by night inside the cut), because the card
 * frame is the only picture of this example most people will see.
 *
 * All three are generators: the input texture is read for its SIZE only (`customWgsl` takes
 * its resolution from its input), so each is fed a project-sized Solid.
 */

const PRELUDE = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
    mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}
`;

/**
 * The outer layer: a wall of Portuguese azulejos, cobalt on a white tin glaze.
 *
 * Each tile is folded eight ways (mirror in x, mirror in y, mirror across the diagonal), so
 * one eighth of the motif is drawn and the rest is symmetry — which is how the real patterns
 * are built too. The corner motif is a quarter disc, so four tiles meeting at a corner make
 * a second, larger rosette: the two-by-two "padrão" read that a single-tile motif lacks.
 * The ink is modulated by a low noise so it reads brushed rather than printed, each tile
 * sits at its own slightly different white, and a slow diagonal sheen crosses the glaze with
 * a per-tile phase, so the wall moves the way a glazed wall catches a passing light.
 */
export const AZULEJO_TILES_WGSL = `struct Params {
  rows: f32, // @default 5 Tile rows over the frame's height.
  sheen: f32, // @default 0.2 Strength of the slow light that crosses the glaze.
};
${PRELUDE}
/* Ink coverage of a signed distance (negative inside) at a width of one pixel. */
fn inkFill(d: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(-aa, aa, d);
}

fn inkBand(d: f32, halfWidth: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(d));
}

/* A leaf: an ellipse along the direction dir, centred on c. */
fn leaf(q: vec2f, c: vec2f, dir: vec2f, len: f32, width: f32) -> f32 {
  let d = q - c;
  let u = dot(d, dir);
  let v = dot(d, vec2f(-dir.y, dir.x));
  return (length(vec2f(u / len, v / width)) - 1.0) * min(len, width);
}

/* The motif of one tile at local coordinates f in [-1, 1]: 1 is cobalt, 0 is glaze. */
fn motif(f: vec2f, aa: f32) -> f32 {
  var q = abs(f);
  if (q.y > q.x) { q = q.yx; }
  let r = length(f);
  let a = atan2(f.y, f.x);

  /* A cobalt field; the white is cut out of it, as the painter leaves the glaze bare. */
  var ink = 1.0;

  /* Centre medallion: a white disc holding an eight-petal rosette with a white eye. */
  ink = ink * (1.0 - inkFill(r - 0.52, aa));
  let petalR = 0.36 * (0.6 + 0.4 * abs(cos(4.0 * a)));
  var rosette = inkFill(r - petalR, aa) * (1.0 - inkBand(r - petalR * 0.6, 0.03, aa));
  rosette = rosette * (1.0 - inkFill(r - 0.07, aa));
  ink = max(ink, rosette);
  ink = ink * (1.0 - inkBand(r - 0.575, 0.012, aa));

  /* The corner quarter disc: four tiles make one white circle round a cobalt quatrefoil. */
  let dcv = q - vec2f(1.0, 1.0);
  let dc = length(dcv);
  let ac = atan2(dcv.y, dcv.x);
  ink = ink * (1.0 - inkFill(dc - 0.4, aa));
  let quatrefoil = inkFill(dc - 0.27 * (0.55 + 0.45 * abs(cos(2.0 * ac))), aa);
  ink = max(ink, quatrefoil * (1.0 - inkFill(dc - 0.06, aa)));

  /* Edge half-disc at the middle of each side, with a cobalt bead: two tiles make one. */
  let de = length(q - vec2f(1.0, 0.0));
  ink = ink * (1.0 - inkFill(de - 0.15, aa));
  ink = max(ink, inkFill(de - 0.065, aa));

  /* White leaves on the field: one along the diagonal, a tendril beside each axis. */
  let diag = vec2f(0.70710678, 0.70710678);
  ink = ink * (1.0 - inkFill(leaf(q, diag * 0.77, diag, 0.12, 0.045), aa));
  let tendril = normalize(vec2f(0.9, 0.44));
  ink = ink * (1.0 - inkFill(leaf(q, vec2f(0.68, 0.21), tendril, 0.11, 0.032), aa));
  return ink;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTexture, 0));
  let aspect = dims.x / dims.y;
  let rows = max(params.rows, 1.0);
  let g = vec2f((uv.x - 0.5) * aspect, uv.y - 0.5) * rows + vec2f(0.5, 0.5);
  let cell = floor(g);
  let f = fract(g) * 2.0 - 1.0;
  /* One pixel, in the tile's own [-1, 1] units. */
  let aa = 2.0 * rows / dims.y;

  let tileHash = hash2(cell + vec2f(17.0, 3.0));
  /* Brushed ink: the density breathes over the tile, never the shape. */
  let brush = 0.9 + 0.1 * noise2(g * 7.0 + vec2f(tileHash * 40.0, 0.0));
  let ink = motif(f, aa) * brush;

  let glaze = vec3f(0.86, 0.87, 0.88) * (0.95 + 0.07 * tileHash);
  let cobalt = vec3f(0.010, 0.045, 0.40);
  var colour = mix(glaze, cobalt, clamp(ink, 0.0, 1.0));

  /* Grout and a soft bevel where the glaze rolls off the tile's edge. */
  let edge = 1.0 - max(abs(f.x), abs(f.y));
  colour = colour * mix(0.72, 1.0, smoothstep(0.0, 0.09, edge));
  colour = mix(vec3f(0.16, 0.17, 0.18), colour, smoothstep(0.0, 0.028, edge));

  /* The sheen: a slow diagonal band, each tile a little out of phase, like uneven glaze. */
  let sweep = (uv.x * aspect + uv.y) * 1.3 - frameU.absTime * 0.12 + tileHash * 0.35;
  let sheen = pow(max(sin(sweep * 3.14159265), 0.0), 10.0) * params.sheen;
  colour = colour + vec3f(0.9, 0.93, 1.0) * sheen * (1.0 - 0.6 * clamp(ink, 0.0, 1.0));

  return vec4f(colour, 1.0);
}`;

/**
 * The inner layer: Lisbon at night, as a timelapse.
 *
 * A hill of houses in six parallax rows under a floodlit castle, sodium light washing the
 * facades from the streets below, windows switching on and off on the timelapse's clock,
 * clouds racing, and one road of light trails across the middle distance. The camera drifts
 * slowly left and right (a sine, not a pan) so the castle stays in the picture for the whole
 * minute. Rows nearer the camera drift further, which is what sells the depth.
 */
export const CITY_NIGHT_WGSL = `struct Params {
  drift: f32, // @default 0.22 How far the timelapse camera drifts sideways, in frame heights.
  lights: f32, // @default 1 Brightness of the windows, the castle and the traffic.
};
${PRELUDE}
fn hill(x: f32) -> f32 {
  return 0.2 * exp(-pow((x - 0.18) / 0.55, 2.0)) + 0.03 * sin(x * 4.1 + 1.3);
}

fn fbm(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 4; i = i + 1) {
    sum = sum + noise2(q) * amp;
    q = q * 2.03 + vec2f(1.7, 9.2);
    amp = amp * 0.5;
  }
  return sum;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTexture, 0));
  let aspect = dims.x / dims.y;
  let p = vec2f((uv.x - 0.5) * aspect, 0.5 - uv.y);
  let t = frameU.absTime;
  let sway = params.drift * sin(t * 0.07);

  /* Sky: navy overhead, the city's own orange haze on the horizon, clouds in a hurry. */
  var colour = mix(vec3f(0.07, 0.035, 0.05), vec3f(0.004, 0.007, 0.03), smoothstep(-0.05, 0.45, p.y));
  let cloud = smoothstep(0.45, 0.8, fbm(vec2f((p.x + sway * 0.1) * 2.2 + t * 0.09, p.y * 5.0)));
  colour = colour + cloud * vec3f(0.05, 0.028, 0.03) * smoothstep(0.5, -0.1, p.y);

  /* The castle on the crest, and its floodlight's glow in the haze. */
  let castleX = 0.18 - sway * 0.3;
  let crest = -0.5 + 0.48 + hill(0.18);
  let cdx = p.x - castleX;
  colour = colour + vec3f(0.22, 0.1, 0.03) * params.lights * exp(-length(vec2f(cdx * 0.8, p.y - crest - 0.1)) * 7.0) * 0.5;
  let crenel = select(0.0, 0.008, fract(cdx * 55.0) < 0.5);
  let towers = select(0.0, 0.035, abs(abs(cdx) - 0.1) < 0.018 || abs(cdx) < 0.02);
  if (abs(cdx) < 0.12 && p.y > crest && p.y < crest + 0.13 + crenel + towers) {
    let lit = 0.35 + 0.65 * smoothstep(crest + 0.16, crest + 0.04, p.y);
    colour = vec3f(0.55, 0.32, 0.11) * lit * params.lights;
  }

  /* Eight rows of houses, back to front. Front rows are wider, taller and drift further. */
  for (var l = 0; l < 8; l = l + 1) {
    let k = f32(l) / 7.0;
    let offset = sway * (0.3 + 0.9 * k) + f32(l) * 3.1;
    let x = p.x + offset;
    let cw = 0.022 * (1.0 + 1.5 * k);
    let c = floor(x / cw);
    let centre = (c + 0.5) * cw - offset;
    let ground = -0.5 + (1.0 - k) * 0.48 + (1.0 - k) * hill(centre + sway * 0.3);
    let h = hash2(vec2f(c, f32(l) * 7.0));
    let top = ground + (0.035 + 0.06 * h) * (1.0 + 0.9 * k);
    /* A lower row stops at the next row's ground; only the part above it is drawn. */
    if (p.y < top) {
      let height = p.y - ground;
      /* Lisbon's pale facades, lit from the street and fading upward, hazier further back. */
      let tone = mix(vec3f(0.05, 0.035, 0.03), vec3f(0.3, 0.2, 0.12), hash2(vec2f(c, f32(l) * 7.0 + 3.0)));
      var facade = tone * (0.2 + 0.8 * exp(-max(height, 0.0) * 10.0 / (1.0 + k)));
      facade = mix(facade, vec3f(0.03, 0.03, 0.06), (1.0 - k) * 0.35);
      if (p.y > top - 0.005 * (1.0 + k)) {
        facade = vec3f(0.06, 0.018, 0.01);
      }
      /* Windows: three across each house, in storeys; each one keeps its own hours. */
      let lx = fract(x / cw);
      let storey = cw * 0.55;
      let ly = height / storey;
      let wx = fract(lx * 3.0);
      let wy = fract(ly);
      let inWindow = wx > 0.3 && wx < 0.7 && wy > 0.3 && wy < 0.75 && ly > 0.6 && p.y < top - storey * 0.4;
      if (inWindow) {
        let id = vec2f(c * 3.0 + floor(lx * 3.0), floor(ly) + f32(l) * 31.0);
        let hours = floor(t * 0.35 + hash2(id + vec2f(5.0, 1.0)) * 11.0);
        if (hash2(id + vec2f(hours, 2.0)) < 0.55) {
          facade = vec3f(1.0, 0.6, 0.22) * (0.5 + 0.7 * hash2(id)) * params.lights;
        }
      }
      colour = facade;
    }
    /* Light trails on the road at the foot of row three. */
    if (l == 4) {
      let road = ground - 0.006;
      let across = abs(p.y - road);
      if (across < 0.006) {
        let dash = fract(x * 9.0 - t * 1.4);
        let back = fract(x * 7.0 + t * 1.1 + 0.37);
        let headlights = smoothstep(0.55, 1.0, dash) * select(0.0, 1.0, p.y > road);
        let tails = smoothstep(0.6, 1.0, back) * select(0.0, 1.0, p.y <= road);
        let falloff = 1.0 - smoothstep(0.0, 0.006, across);
        colour = colour + (vec3f(1.0, 0.85, 0.6) * headlights + vec3f(0.9, 0.06, 0.03) * tails) * falloff * params.lights;
      }
    }
  }
  return vec4f(colour, 1.0);
}`;

/**
 * The mask's understudy: two people, seen from behind, holding hands — the reference's
 * couple — white where a person is, black elsewhere, which is what the Matte and Person Mask
 * nodes publish for a real camera.
 *
 * Each figure is a union of tapered capsules (head, neck, torso, shoulders, two arms, two
 * legs) joined with a smooth minimum, so the joints read as a body rather than a stick
 * figure. They breathe, shift their weight and swing their free arms on absolute time, and
 * the joined hands drift between them — enough that the silhouette is alive and the cut
 * edge travels over both layers, never so much that it reads as a walk cycle.
 */
export const STAND_IN_FIGURES_WGSL = `struct Params {
  sway: f32, // @default 1 How much the two figures move; 0 holds them still.
};
${PRELUDE}
fn capsule(p: vec2f, a: vec2f, b: vec2f, ra: f32, rb: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

/* One figure standing at feet, height H, width scale w; side is +1 when the partner is to
   the right; hand is where the inner hand is held; swing moves the free arm; hair adds a
   fall of hair past the shoulders. */
fn figure(p: vec2f, feet: vec2f, H: f32, w: f32, side: f32, hand: vec2f, swing: f32, lean: f32, hair: f32) -> f32 {
  let o = feet;
  let hip = o + vec2f(lean * 0.6, 0.52 * H);
  let chest = o + vec2f(lean, 0.72 * H);
  let neck = o + vec2f(lean * 1.2, 0.85 * H);
  let head = o + vec2f(lean * 1.4, 0.93 * H);
  let k = 0.025 * H;

  var d = length((p - head) / vec2f(0.058 * H * w, 0.07 * H)) - 1.0;
  d = d * 0.06 * H;
  d = smin(d, capsule(p, chest, neck, 0.03 * H, 0.028 * H), k);
  d = smin(d, capsule(p, hip, chest, 0.085 * H * w, 0.105 * H * w), k);
  let shoulderL = chest + vec2f(-0.12 * H * w, 0.06 * H);
  let shoulderR = chest + vec2f(0.12 * H * w, 0.06 * H);
  d = smin(d, capsule(p, shoulderL, shoulderR, 0.04 * H, 0.04 * H), k);

  /* The inner arm reaches for the partner's hand; the outer arm hangs and swings. */
  let innerShoulder = select(shoulderL, shoulderR, side > 0.0);
  let outerShoulder = select(shoulderR, shoulderL, side > 0.0);
  let innerElbow = mix(innerShoulder, hand, 0.5) + vec2f(0.0, -0.05 * H);
  d = smin(d, capsule(p, innerShoulder, innerElbow, 0.036 * H, 0.03 * H), k);
  d = smin(d, capsule(p, innerElbow, hand, 0.03 * H, 0.026 * H), k);
  let outerElbow = outerShoulder + vec2f(-side * 0.035 * H + swing * 0.3, -0.17 * H);
  let outerHand = outerElbow + vec2f(-side * 0.01 * H + swing, -0.16 * H);
  d = smin(d, capsule(p, outerShoulder, outerElbow, 0.036 * H, 0.03 * H), k);
  d = smin(d, capsule(p, outerElbow, outerHand, 0.03 * H, 0.026 * H), k);

  /* Legs, a little apart, and small feet. */
  for (var s = -1.0; s < 2.0; s = s + 2.0) {
    let legHip = hip + vec2f(s * 0.05 * H * w, -0.02 * H);
    let knee = o + vec2f(s * 0.06 * H * w + lean * 0.3, 0.28 * H);
    let ankle = o + vec2f(s * 0.065 * H * w, 0.035 * H);
    d = smin(d, capsule(p, legHip, knee, 0.058 * H * w, 0.045 * H * w), k);
    d = smin(d, capsule(p, knee, ankle, 0.045 * H * w, 0.03 * H * w), k);
    d = smin(d, capsule(p, ankle, ankle + vec2f(s * 0.02 * H, -0.03 * H), 0.03 * H, 0.025 * H), k);
  }

  /* Hair past the shoulders, when there is any. */
  if (hair > 0.0) {
    d = smin(d, capsule(p, head + vec2f(0.0, -0.01 * H), head + vec2f(0.0, -0.14 * H), 0.06 * H, 0.05 * H), k);
  }
  return d;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTexture, 0));
  let aspect = dims.x / dims.y;
  let p = vec2f((uv.x - 0.5) * aspect, 0.5 - uv.y);
  let t = frameU.absTime;
  let s = params.sway;

  /* The joined hands between them drift a little; everything else answers to them. */
  let hand = vec2f(0.012 * sin(t * 0.31) * s, -0.105 + 0.012 * sin(t * 0.83) * s);

  let leanA = 0.012 * sin(t * 0.47) * s;
  let leanB = 0.012 * sin(t * 0.47 + 2.1) * s;
  let footA = vec2f(-0.22 + 0.006 * sin(t * 0.21) * s, -0.47);
  let footB = vec2f(0.21 + 0.006 * sin(t * 0.21 + 1.3) * s, -0.47);
  let a = figure(p, footA, 0.86, 1.0, 1.0, hand, 0.014 * sin(t * 0.9) * s, leanA, 0.0);
  let b = figure(p, footB, 0.79, 0.88, -1.0, hand, 0.014 * sin(t * 0.9 + 1.7) * s, leanB, 1.0);
  let d = min(a, b);
  let px = 1.0 / dims.y;
  let m = 1.0 - smoothstep(-px, px, d);
  return vec4f(m, m, m, 1.0);
}`;
