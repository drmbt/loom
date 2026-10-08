import type { Interpolation, PennerFamily } from "./model.ts";

/**
 * VN61 — CLOSED-FORM EASES: u in 0..1 → progress, 0 at u = 0 and 1 at u = 1.
 *
 * TD's named eases are the smooth ones (`ease` is the cubic smoothstep, `easein` /
 * `easeout` its halves as quadratics); the `p` variants raise to the key's `power`. The
 * Penner set is Robert Penner's easing equations as every tool ships them (the standard
 * forms, constants included: back's 1.70158, elastic's 2π/3, bounce's 7.5625 / 2.75).
 * Back and elastic OVERSHOOT 0..1 by design, which is what a lane's clamp flag is for.
 *
 * `constant`, `linear`, `cubic` and `bezier` are not here: they read the keys' values or
 * handles, not just u, and live in `evaluate.ts`.
 */

const HALF_PI = Math.PI / 2;
const BACK = 1.70158;
const BACK_IN_OUT = BACK * 1.525;
const ELASTIC = (2 * Math.PI) / 3;
const ELASTIC_IN_OUT = (2 * Math.PI) / 4.5;

function bounceOut(u: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (u < 1 / d1) return n1 * u * u;
  if (u < 2 / d1) return n1 * (u -= 1.5 / d1) * u + 0.75;
  if (u < 2.5 / d1) return n1 * (u -= 2.25 / d1) * u + 0.9375;
  return n1 * (u -= 2.625 / d1) * u + 0.984375;
}

const POWERS: Partial<Record<PennerFamily, number>> = { Quad: 2, Cubic: 3, Quart: 4, Quint: 5 };

type Direction = "in" | "out" | "inOut";

/** The `in` form; `out` and `inOut` are derived from it except where the closed form differs. */
function pennerIn(family: PennerFamily, u: number): number {
  const power = POWERS[family];
  if (power !== undefined) return u ** power;
  switch (family) {
    case "Sine":
      return 1 - Math.cos(u * HALF_PI);
    case "Expo":
      return u === 0 ? 0 : 2 ** (10 * u - 10);
    case "Circ":
      return 1 - Math.sqrt(1 - u * u);
    case "Back":
      return (BACK + 1) * u * u * u - BACK * u * u;
    case "Elastic":
      return u === 0 ? 0 : u === 1 ? 1 : -(2 ** (10 * u - 10)) * Math.sin((u * 10 - 10.75) * ELASTIC);
    case "Bounce":
      return 1 - bounceOut(1 - u);
    default:
      return u;
  }
}

function penner(family: PennerFamily, direction: Direction, u: number): number {
  if (direction === "in") return pennerIn(family, u);
  if (direction === "out") return 1 - pennerIn(family, 1 - u);
  // inOut: the in form over the first half, the out form over the second — except for the
  // two whose standard inOut is its own curve (back's larger overshoot, elastic's period).
  if (family === "Back") {
    return u < 0.5
      ? ((2 * u) ** 2 * ((BACK_IN_OUT + 1) * 2 * u - BACK_IN_OUT)) / 2
      : ((2 * u - 2) ** 2 * ((BACK_IN_OUT + 1) * (u * 2 - 2) + BACK_IN_OUT) + 2) / 2;
  }
  if (family === "Elastic") {
    if (u === 0 || u === 1) return u;
    return u < 0.5
      ? -(2 ** (20 * u - 10) * Math.sin((20 * u - 11.125) * ELASTIC_IN_OUT)) / 2
      : (2 ** (-20 * u + 10) * Math.sin((20 * u - 11.125) * ELASTIC_IN_OUT)) / 2 + 1;
  }
  return u < 0.5 ? pennerIn(family, 2 * u) / 2 : 1 - pennerIn(family, 2 - 2 * u) / 2;
}

const PENNER_PATTERN = /^(inOut|in|out)(Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce)$/;

/**
 * Progress at u for an ease interpolation, or null for one that is not a pure ease of u
 * (`constant`, `linear`, `cubic`, `bezier`). `power` is the key's exponent for the `p` forms.
 */
export function easeProgress(interp: Interpolation, u: number, power = 2): number | null {
  // The ends are exact by definition: a key is hit exactly, whatever cos(π/2) rounds to.
  if (u <= 0 || u >= 1) {
    const pure = interp !== "constant" && interp !== "linear" && interp !== "cubic" && interp !== "bezier";
    return pure ? (u <= 0 ? 0 : 1) : null;
  }
  switch (interp) {
    case "ease":
      return u * u * (3 - 2 * u);
    case "easein":
      return u * u;
    case "easeout":
      return 1 - (1 - u) * (1 - u);
    case "easep":
      return u < 0.5 ? 0.5 * (2 * u) ** power : 1 - 0.5 * (2 - 2 * u) ** power;
    case "easeinp":
      return u ** power;
    case "easeoutp":
      return 1 - (1 - u) ** power;
    case "constant":
    case "linear":
    case "cubic":
    case "bezier":
      return null;
    default: {
      const match = PENNER_PATTERN.exec(interp);
      if (match === null) return null;
      return penner(match[2] as PennerFamily, match[1] as Direction, u);
    }
  }
}
