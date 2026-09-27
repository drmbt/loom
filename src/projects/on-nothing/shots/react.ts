import type { GraphEdge, GraphNode } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { edge, expressionSlot, node as buildNode } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";

/**
 * T1407b — REACTIVITY: what happens to the light INSIDE a shot, measured off the reference
 * (docs/on-nothing-reactivity-2026-09-27.md; the numbers below are that doc's tables).
 *
 * What the measurement found, 0–42 s (rows 1–37), against the song's 156 BPM grid and loom's
 * own kick / snare / hat lanes:
 *
 * - The streak columns FLICKER, each column on its own, every frame: the streak energy of a
 *   continuous dark shot moves by 8–24 % (sd, frame to frame, after the slow trend is taken
 *   out), with almost no frame-to-frame memory (lag-1 autocorrelation ≈ 0.1). Ours moved by
 *   0.4 %. It is FREE-RUNNING: it does not lock to the beat grid, the backbeat, the snare or the
 *   hat lane (|z| < 2 everywhere), and its depth does not follow the song's loudness.
 * - Columns POP: one shoots up the frame for 1–4 frames (median 1), about once a second of
 *   dark footage, off the grid (beat phase uniform).
 * - The one lane that does line up: loom's KICK lane. On a kick the columns reach further
 *   (+0.06 frame heights over the whole song, +0.18 in the first 42 s; z 3.7 / 4.1), from the
 *   hit's own frame, half gone two frames later.
 * - The lamps' light on the room (everything but the columns and the clipped cores) moves by
 *   5–9 % a frame in the same shots; ours by 0.5 %.
 * - Camera jolts and exposure pulses are NOT on the beat (|z| < 1.5): nothing here moves the
 *   camera on a hit, and flash frames sit at cuts — the edit's business (the parts in edl.json).
 *
 * So the hook is a free-running flicker of the glass and the lamps, per column, plus a short
 * reach on the kick lane. Every term steps once per 24 fps frame (sub-frames of a --final render
 * share it, so motion blur never averages it away).
 */

/** How one shot's light reacts; every number is measured (see the doc's per-row table). */
export interface ReactProfile {
  /** Per-column flicker depth: each column's gain is 1 ± this (uniform), fresh every frame. */
  readonly columns: number;
  /** Columns across the frame width (a band about as wide as one headlight's column). */
  readonly bands: number;
  /** A popping column's extra gain, and the chance a column pops on a frame. */
  readonly pop: number;
  readonly popChance: number;
  /** The lamps' own flicker (projectors, haze, all columns together): gain 1 ± this. */
  readonly lamp: number;
  /** The streak gain the kick lane adds on its hit (falls to 0 over `kickTail` seconds). */
  readonly kick: number;
}

/** Profiles per shot family, each tuned against its reference row (the doc's verification table). */
export const REACT_PROFILES = {
  /** Row 17 (0:15.3, the 0:16 tableau) and what shares its set: zoom (row 22), halo (row 35). */
  tableau: { columns: 1.2, bands: 16, pop: 1.4, popChance: 0.012, lamp: 0.15, kick: 0.8 },
  /** Row 1 (0:00, the title): its stock Streak has no per-column hook, so the whole glass flickers together. */
  title: { columns: 0, bands: 1, pop: 0, popChance: 0, lamp: 0.5, kick: 0 },
} as const satisfies Record<string, ReactProfile>;

export const REACT_FPS = 24;
const KICK_TAIL = 0.12;

/** A 0..1 value, fresh every 24 fps frame, from `seed`. */
export function frameHash(seed: number): string {
  return `fract(sin(floor(abstime * ${REACT_FPS}) * 12.9898 + ${seed}) * 43758.5453)`;
}

/** `base` × (1 ± depth), fresh every frame: a lamp's flicker as an expression. */
export function flicker(base: number, depth: number, seed = 1.7): StoredParameter {
  return depth === 0 ? base : expressionSlot(`${base} * (1 + ${depth} * (${frameHash(seed)} * 2 - 1))`, base);
}

/** The per-column flicker over the streak glass's output (before it is added back). */
export const STREAK_FLICKER_WGSL = `struct Params {
  depth: f32, // @default 0.5  Per-column flicker depth: each column's gain is 1 +- this, fresh every frame.
  bands: f32, // @default 16  Columns across the frame width.
  pop: f32, // @default 1.4  Extra gain of a popping column.
  popChance: f32, // @default 0.01  Chance a column pops on a frame.
  gain: f32, // @default 1  Every column together (the lamps' flicker, the kick).
  rate: f32, // @default 24  Frames a second the flicker steps at.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

fn reactHash(p: vec2f) -> f32 {
  var q = fract(vec3f(p.x, p.y, p.x + p.y) * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn columnGain(c: f32, f: f32) -> f32 {
  let u = reactHash(vec2f(c * 7.13 + 1.0, f * 1.37 + 5.0)) * 2.0 - 1.0;
  let popping = step(1.0 - params.popChance, reactHash(vec2f(c * 3.7 + 11.0, f * 2.11 + 17.0)));
  return max(0.0, 1.0 + params.depth * u + params.pop * popping);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let f = floor(frameU.absTime * params.rate + 0.001);
  let x = uv.x * params.bands - 0.5;
  let i = floor(x);
  let g = mix(columnGain(i, f), columnGain(i + 1.0, f), smoothstep(0.0, 1.0, x - i));
  return vec4f(c.rgb * g * params.gain, c.a);
}`;

export interface Reactive {
  /** The flickering columns: pass the streak glass's output port, use the returned one instead. */
  streak(from: readonly [string, string]): readonly [string, string];
  /** A lamp's brightness (a projector's, the haze's head term), flickering with the room's lamps. */
  lamp(base: number): StoredParameter;
}

/**
 * The hook: adds its nodes to `nodes` / `edges`. `song` is the id of the graph's Audio File In
 * (undefined: no song, the kick term idles and the flicker still runs).
 */
export function reactive(nodes: GraphNode[], edges: GraphEdge[], profile: ReactProfile, song: string | undefined): Reactive {
  const lampHash = frameHash(1.7);
  const lampGain = `(1 + ${profile.lamp} * (${lampHash} * 2 - 1))`;
  let kick = "0";
  if (song !== undefined && profile.kick > 0) {
    nodes.push(buildNode("reactKickPick", "valueSelect", [-3900, 1700], {}, { label: "reactkickpick1", parameters: { channels: "kickCount" } }));
    // 1 on a kick-lane hit, gone KICK_TAIL later (half gone after two frames, as measured).
    nodes.push(buildNode("reactKick", "valueBeat", [-3600, 1700], {}, { label: "reactkick1", parameters: { threshold: 0.5, retrigger: 0.1, tail: KICK_TAIL, decay: "linear" } }));
    edges.push(edge("react-kick-pick", [song, "out"], ["reactKickPick", "in"]));
    edges.push(edge("react-kick-beat", ["reactKickPick", "out"], ["reactKick", "in"]));
    kick = "op('reactkick1').chan.kickCount";
  }
  return {
    streak(from) {
      nodes.push(buildNode("reactStreak", "customWgsl", [-800, 300], {}, {
        label: "reactstreak1",
        resolution: { mode: "scale", factor: 1 },
        parameters: {
          source: STREAK_FLICKER_WGSL,
          depth: profile.columns,
          bands: profile.bands,
          pop: profile.pop,
          popChance: profile.popChance,
          gain: expressionSlot(`${lampGain} * (1 + ${profile.kick} * ${kick})`, 1),
          rate: REACT_FPS,
        },
      }));
      edges.push(edge("react-streak-in", from, ["reactStreak", "input"]));
      return ["reactStreak", "out"];
    },
    lamp(base) {
      return profile.lamp === 0 ? base : expressionSlot(`${base} * ${lampGain}`, base);
    },
  };
}
