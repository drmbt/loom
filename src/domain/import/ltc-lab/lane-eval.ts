/**
 * VN100 — LTC-LAB'S GENERATED-LANE EVALUATION, PORTED, AND THE BAKE TO LOOM KEYS.
 *
 * Ported from ltc-lab (read-only, ../ltc-lab), keeping its semantics exactly:
 *  - `src/lib/lane-eval.ts`: `adsrAt`, `onsetValue` (layer / restart), `sampledValue`,
 *    `MIN_RISE_SEC`, `isGenerated`;
 *  - `src/lib/triggers.ts`: `processHits` / `processHitsPerGrid` (quantize, refractory,
 *    velocity, per-song grids);
 *  - `src/lib/figures.ts`: `figureValue`, `shapeAt`, the sample-and-hold hash, the 120 BPM
 *    fallback grid;
 *  - `src/lib/beat-grid.ts`: `beatAt`, `beatSec`; `src/lib/songs.ts`: `gridAt`;
 *  - `src/lib/rms.ts`: `simplify` (the bounded-slope polyline reducer `lane-bake` uses).
 *
 * What differs from ltc-lab's own `bakeLane` (`src/lib/lane-bake.ts`): that samples at
 * 30 Hz and writes flat-handled bezier keys. A 1/8-note pulse at 148 BPM is 30 ms wide, so
 * 30 Hz drops whole pulses; this samples at `rateHz` (240 Hz by default, 1000 ticks) and
 * writes LINEAR keys, which Loom evaluates as exactly the sampled polyline.
 *
 * Pure: no DOM, no clock. Everything returns the NORMALIZED value 0..1.
 */

import type { LtcEnvelopeADSR, LtcFigureSource, LtcGrid, LtcLane, LtcSong, LtcTriggerOpts } from "./ltc-types.ts";

type Hit = readonly [number, number];
type GridAt = (t: number) => LtcGrid | null;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const frac = (v: number): number => v - Math.floor(v);

export const MIN_RISE_SEC = 0.01;

export function isGenerated(lane: LtcLane): boolean {
  const s = lane.source;
  return !!s && ((s.kind === "onsets" && !!s.hits) || (s.kind === "level" && !!s.samples) || s.kind === "figure");
}

// ---- grid (beat-grid.ts, songs.ts) ------------------------------------------------------

const beatSec = (g: LtcGrid): number => 60 / g.bpm;
const beatAt = (g: LtcGrid, t: number): number => (t - g.anchor) / beatSec(g);

/** The grid at t: the song playing then (its own grid, if it has one), else the track's. */
export function gridSourceOf(track: { readonly grid?: LtcGrid | null; readonly songs?: readonly LtcSong[] }): GridAt {
  const songs = [...(track.songs ?? [])].sort((a, b) => a.offset - b.offset);
  return (t) => {
    let current: LtcSong | undefined = songs[0];
    for (const song of songs) {
      if (song.offset <= t + 1e-9) current = song;
      else break;
    }
    return current?.grid ?? track.grid ?? null;
  };
}

// ---- onsets (lane-eval.ts, triggers.ts) --------------------------------------------------

function fall(p: number, curve: "linear" | "exp" | "smooth"): number {
  if (curve === "linear") return p;
  if (curve === "smooth") return p * p * (3 - 2 * p);
  return (1 - Math.exp(-5 * p)) / (1 - Math.exp(-5));
}

export function adsrAt(dt: number, velocity: number, adsr: LtcEnvelopeADSR, curve: "linear" | "exp" | "smooth"): number {
  const A = Math.max(MIN_RISE_SEC, Math.max(0, adsr.attackMs) / 1000);
  const D = Math.max(0, adsr.decayMs) / 1000;
  const R = Math.max(0, adsr.releaseMs) / 1000;
  const S = clamp01(adsr.sustain);
  if (dt < -A) return 0;
  if (dt < 0) return A > 0 ? velocity * ((dt + A) / A) : velocity;
  if (dt < D) return velocity * (1 - (1 - S) * fall(dt / D, curve));
  if (S <= 0) return 0;
  const r = dt - D;
  if (r < R) return velocity * S * (1 - fall(r / R, curve));
  return 0;
}

function lowerBound(times: (i: number) => number, n: number, t: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times(mid) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function onsetValue(
  hits: readonly Hit[],
  adsr: LtcEnvelopeADSR,
  t: number,
  curve: "linear" | "exp" | "smooth" = "exp",
  retrigger: "layer" | "restart" = "layer",
): number {
  if (hits.length === 0) return 0;
  const tail = (Math.max(0, adsr.decayMs) + Math.max(0, adsr.releaseMs)) / 1000;
  const lead = Math.max(MIN_RISE_SEC, Math.max(0, adsr.attackMs) / 1000);
  let i = lowerBound((k) => (hits[k] as Hit)[0], hits.length, t - tail);
  if (retrigger === "restart") {
    let owner = -1;
    for (; i < hits.length && (hits[i] as Hit)[0] - lead <= t; i++) owner = i;
    return owner < 0 ? 0 : clamp01(adsrAt(t - (hits[owner] as Hit)[0], (hits[owner] as Hit)[1], adsr, curve));
  }
  let v = 0;
  for (; i < hits.length && (hits[i] as Hit)[0] <= t + lead; i++) {
    const e = adsrAt(t - (hits[i] as Hit)[0], (hits[i] as Hit)[1], adsr, curve);
    if (e > v) v = e;
  }
  return clamp01(v);
}

function accentOf(g: LtcGrid, t: number): number {
  const b = (t - g.anchor) / beatSec(g);
  const nearest = Math.round(b);
  if (Math.abs(b - nearest) > 0.12) return 0.5;
  return ((nearest % g.beatsPerBar) + g.beatsPerBar) % g.beatsPerBar === 0 ? 1 : 0.75;
}

export function processHits(hits: readonly Hit[], opts: LtcTriggerOpts | undefined, grid: LtcGrid | null): Hit[] {
  if (!opts) return [...hits];
  let out: Hit[] = [...hits];
  const q = opts.quantize;
  if (q && grid) {
    const step = beatSec(grid) / (q.division / 4);
    const tol = Math.max(0, q.toleranceMs) / 1000;
    const snapped = out.map(([t, v]): Hit => {
      const k = Math.round((t - grid.anchor) / step);
      const ts = grid.anchor + k * step;
      return Math.abs(ts - t) <= tol ? [ts, v] : [t, v];
    });
    const merged: Hit[] = [];
    for (const h of snapped.sort((a, b) => a[0] - b[0])) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev[0] - h[0]) < 1e-6) {
        if (h[1] > prev[1]) merged[merged.length - 1] = h;
      } else merged.push(h);
    }
    out = merged;
  }
  const refr = Math.max(0, opts.refractoryMs ?? 0) / 1000;
  if (refr > 0) {
    const kept: Hit[] = [];
    for (const h of out) {
      const prev = kept[kept.length - 1];
      if (!prev || h[0] - prev[0] >= refr) kept.push(h);
    }
    out = kept;
  }
  if (opts.velocity === "fixed") out = out.map(([t]): Hit => [t, 1]);
  else if (opts.velocity === "accent" && grid) out = out.map(([t]): Hit => [t, accentOf(grid, t)]);
  return out;
}

/** Medleys: each hit is processed against the grid of the song it falls in. */
export function processHitsPerGrid(hits: readonly Hit[], opts: LtcTriggerOpts | undefined, gridAt: GridAt): Hit[] {
  if (!opts) return [...hits];
  const groups = new Map<LtcGrid | null, Hit[]>();
  for (const h of hits) {
    const g = gridAt(h[0]);
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(h);
  }
  return [...groups].flatMap(([g, list]) => processHits(list, opts, g)).sort((a, b) => a[0] - b[0]);
}

// ---- level (lane-eval.ts) ------------------------------------------------------------------

export function sampledValue(samples: { readonly rate: number; readonly values: readonly number[] }, t: number): number {
  const { rate, values } = samples;
  if (!values.length || rate <= 0) return 0;
  const x = t * rate;
  if (x <= 0) return clamp01(values[0] as number);
  const i = Math.floor(x);
  if (i >= values.length - 1) return clamp01(values[values.length - 1] as number);
  const f = x - i;
  return clamp01((values[i] as number) + ((values[i + 1] as number) - (values[i] as number)) * f);
}

// ---- figures (figures.ts) ------------------------------------------------------------------

function hash01(seed: number, n: number): number {
  let h = (seed * 374761393 + n * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function drawnAt(points: readonly (readonly [number, number])[], p: number): number {
  if (!points.length) return 0;
  const first = points[0] as readonly [number, number];
  if (p <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i] as readonly [number, number];
    if (p <= x1) {
      const [x0, y0] = points[i - 1] as readonly [number, number];
      return x1 > x0 ? y0 + ((y1 - y0) * (p - x0)) / (x1 - x0) : y1;
    }
  }
  return (points[points.length - 1] as readonly [number, number])[1];
}

export function shapeAt(f: LtcFigureSource, p: number, cycle: number): number {
  switch (f.shape) {
    case "sine":
      return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
    case "triangle":
      return p < 0.5 ? p * 2 : 2 - p * 2;
    case "saw-up":
      return p;
    case "saw-down":
      return 1 - p;
    case "square":
      return p < (f.width ?? 0.5) ? 1 : 0;
    case "pulse":
      return p < (f.width ?? 0.1) ? 1 : 0;
    case "ease":
      return p * p * (3 - 2 * p);
    case "random":
      return hash01(f.seed ?? 1, cycle);
    case "drawn":
      return clamp01(drawnAt(f.points ?? [], p));
  }
  return 0;
}

const FALLBACK_GRID: LtcGrid = { bpm: 120, anchor: 0, beatsPerBar: 4 };

export function figureValue(f: LtcFigureSource, t: number, grid: LtcGrid | null): number {
  const low = clamp01(f.low);
  const high = clamp01(f.high);
  if (f.range && (t < f.range.start || t > f.range.end)) return low;
  const g = grid ?? FALLBACK_GRID;
  const len = Math.max(1 / 64, f.beats);
  const pos = beatAt(g, t) / len + (f.phase ?? 0);
  const cycle = Math.floor(pos);
  let p = frac(pos);
  const swing = Math.max(0, Math.min(0.5, f.swing ?? 0));
  if (swing > 0 && ((cycle % 2) + 2) % 2 === 1) p = p < swing ? 0 : (p - swing) / (1 - swing);
  return low + (high - low) * shapeAt(f, p, cycle);
}

// ---- one generated lane, normalized ---------------------------------------------------------

/** A generated lane's normalized value at t (automation.ts `evaluateLane`, its generated branches). */
export function generatedValue(lane: LtcLane, t: number, gridAt: GridAt): number {
  const src = lane.source;
  if (src?.kind === "onsets" && src.hits) {
    const hits = processHitsPerGrid(src.hits, src.triggers, gridAt);
    return onsetValue(hits, src.adsr, t, src.curve ?? "exp", src.triggers?.retrigger ?? "layer");
  }
  if (src?.kind === "figure") return figureValue(src, t, gridAt(t));
  if (src?.kind === "level" && src.samples) return sampledValue(src.samples, t);
  return 0;
}

// ---- the bake ---------------------------------------------------------------------------------

/**
 * rms.ts `simplify`: indices of a polyline that stays within `tol` of every sample.
 * Greedy, bounded slope; keeps the first and last sample.
 */
export function simplify(curve: ArrayLike<number>, tol: number): number[] {
  const n = curve.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const kept: number[] = [0];
  let anchor = 0;
  let y0 = curve[0] as number;
  let lo = -Infinity;
  let hi = Infinity;
  let i = 1;
  while (i < n) {
    const d = i - anchor;
    const s = ((curve[i] as number) - y0) / d;
    if (s < lo || s > hi) {
      anchor = i - 1;
      y0 = curve[anchor] as number;
      kept.push(anchor);
      lo = -Infinity;
      hi = Infinity;
      continue;
    }
    const a = ((curve[i] as number) - y0 - tol) / d;
    const b = ((curve[i] as number) - y0 + tol) / d;
    if (a > lo) lo = a;
    if (b < hi) hi = b;
    i += 1;
  }
  if (kept[kept.length - 1] !== n - 1) kept.push(n - 1);
  return kept;
}

export interface BakedPoint {
  readonly seconds: number;
  readonly v: number;
}

/**
 * A generated lane sampled at `rateHz` over [0, durationSec] and reduced to the vertices
 * of a polyline within `tolerance` of it. Read with linear interpolation between points.
 */
export function bakeGenerated(lane: LtcLane, durationSec: number, gridAt: GridAt, rateHz: number, tolerance: number): BakedPoint[] {
  const n = Math.max(2, Math.ceil(durationSec * rateHz) + 1);
  const curve = new Float64Array(n);
  for (let i = 0; i < n; i++) curve[i] = clamp01(generatedValue(lane, i / rateHz, gridAt));
  return simplify(curve, tolerance).map((i) => ({ seconds: i / rateHz, v: curve[i] as number }));
}
