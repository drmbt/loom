/**
 * E89's PLATE: the mode tables a modal Chladni/Bessel field sums over (§T1713b).
 *
 * A plate's figure is its forced response, Σ φᵢ(x) φᵢ(r₀) / (kᵢ² − k² + iηk²) (Tuan et al.
 * 2015): one mode dominates at a resonance, so the figure is crisp there and smeared between.
 * The modes are computed here, once, at build time, and inlined into the shaders as constant
 * tables. Lengths are in DISH units (the liquid's dish has radius 1).
 *
 *   circle   J_m(k r) cos(mθ), k = j′ₘₙ (zeros of J′_m: a free rim, the wall the liquid has)
 *   square   Chladni's ψ± = cos(nπu)cos(mπv) ± cos(mπu)cos(nπv) on a square of half-side
 *            SQUARE_HALF, the membrane approximation every textbook figure is drawn from
 *   hexagon  sums over the twelve images of a vector k of the hexagonal reciprocal lattice:
 *            periodic on the lattice the hexagon tiles and even under each of its mirrors, so
 *            the normal slope vanishes on every edge (free edges); D6 by construction
 *
 * Each table row is a vec4f, its meaning per shape:
 *   circle   (m, k, 0, 0)
 *   square   (n, m, sign, k)
 *   hexagon  (kx, ky, 0, k)
 */

/** Bessel J_m(x) by its integral, J_m(x) = (1/π) ∫₀^π cos(mτ − x sin τ) dτ (Simpson). */
function besselJ(m: number, x: number): number {
  const steps = 400;
  const h = Math.PI / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i += 1) {
    const tau = i * h;
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    sum += weight * Math.cos(m * tau - x * Math.sin(tau));
  }
  return (sum * h) / 3 / Math.PI;
}

/** J′_m(x) = (J_{m−1}(x) − J_{m+1}(x)) / 2, with J_{−1} = −J_1. */
function besselJPrime(m: number, x: number): number {
  const below = m === 0 ? -besselJ(1, x) : besselJ(m - 1, x);
  return (below - besselJ(m + 1, x)) / 2;
}

/** The highest wavenumber any table reaches: k = PLATE_SCALE·√f stays under it to ~190 Hz. */
export const PLATE_K_MAX = 40;
export const SQUARE_HALF = 0.85;
export const HEX_APOTHEM = 0.9;

/** The non-zero zeros of J′_m below PLATE_K_MAX, m = 0 … 30: the free circular plate's modes. */
function circleModes(): Array<readonly [number, number, number, number]> {
  const rows: Array<readonly [number, number, number, number]> = [];
  for (let m = 0; m <= 30; m += 1) {
    const step = 0.05;
    let x = Math.max(0.5, m * 0.8);
    let previous = besselJPrime(m, x);
    while (x < PLATE_K_MAX) {
      const next = x + step;
      const value = besselJPrime(m, next);
      if (Math.sign(value) !== Math.sign(previous) && previous !== 0) {
        let lo = x;
        let hi = next;
        for (let i = 0; i < 40; i += 1) {
          const mid = (lo + hi) / 2;
          if (Math.sign(besselJPrime(m, mid)) === Math.sign(besselJPrime(m, lo))) lo = mid;
          else hi = mid;
        }
        rows.push([m, (lo + hi) / 2, 0, 0]);
      }
      previous = value;
      x = next;
    }
  }
  return rows;
}

function squareModes(): Array<readonly [number, number, number, number]> {
  const rows: Array<readonly [number, number, number, number]> = [];
  const unit = Math.PI / (2 * SQUARE_HALF);
  for (let n = 0; n <= 24; n += 1) {
    for (let m = n; m <= 24; m += 1) {
      if (n === 0 && m === 0) continue;
      const k = unit * Math.hypot(n, m);
      if (k >= PLATE_K_MAX) continue;
      rows.push([n, m, 1, k]);
      if (n !== m) rows.push([n, m, -1, k]);
    }
  }
  return rows;
}

function hexagonModes(): Array<readonly [number, number, number, number]> {
  // The hexagon of apothem a tiles the plane on the lattice 2a(1,0), 2a(½,√3/2); its
  // reciprocal basis is (π/a)(1, −1/√3) and (π/a)(0, 2/√3). One row per D6 orbit: the image
  // inside the 0°..30° sector stands for all twelve.
  const s = Math.PI / HEX_APOTHEM;
  const seen = new Set<string>();
  const rows: Array<readonly [number, number, number, number]> = [];
  for (let p = -16; p <= 16; p += 1) {
    for (let q = -16; q <= 16; q += 1) {
      const kx = s * p;
      const ky = s * (-p / Math.sqrt(3) + (2 * q) / Math.sqrt(3));
      const k = Math.hypot(kx, ky);
      if (k < 1e-6 || k >= PLATE_K_MAX) continue;
      let angle = Math.atan2(ky, kx);
      angle = ((angle % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3);
      if (angle > Math.PI / 6) angle = Math.PI / 3 - angle;
      const key = `${k.toFixed(4)}:${angle.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([k * Math.cos(angle), k * Math.sin(angle), 0, k]);
    }
  }
  return rows.sort((a, b) => a[3] - b[3]);
}

const CIRCLE = circleModes().sort((a, b) => a[1] - b[1]);
const SQUARE = squareModes().sort((a, b) => a[3] - b[3]);
const HEXAGON = hexagonModes();

export const PLATE_MODE_COUNTS = { circle: CIRCLE.length, square: SQUARE.length, hexagon: HEXAGON.length } as const;
/** Rows of the mode-amplitude texture: one per mode of the largest table. */
export const PLATE_MODE_SLOTS = Math.max(CIRCLE.length, SQUARE.length, HEXAGON.length);

const vec4 = (row: readonly number[]) => `vec4f(${row.map((value) => (Number.isInteger(value) ? `${value}.0` : value.toFixed(6))).join(", ")})`;
const table = (name: string, rows: ReadonlyArray<readonly number[]>) =>
  `var<private> ${name}: array<vec4f, ${rows.length}> = array<vec4f, ${rows.length}>(\n  ${rows.map(vec4).join(",\n  ")},\n);`;

/** The three tables and their sizes, as WGSL. */
export const PLATE_TABLES_WGSL = [
  `const CIRCLE_MODES: u32 = ${CIRCLE.length}u;`,
  `const SQUARE_MODES: u32 = ${SQUARE.length}u;`,
  `const HEXAGON_MODES: u32 = ${HEXAGON.length}u;`,
  table("CIRCLE", CIRCLE),
  table("SQUARE", SQUARE),
  table("HEXAGON", HEXAGON),
].join("\n");
