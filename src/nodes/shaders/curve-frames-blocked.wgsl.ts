import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { STRIP_WALK_BLOCK } from "../../points/curve.ts";
import { FRAME_MATH_WGSL, curveFramesTerms, writeRunWgsl, type CurveFramesShaderOptions } from "./curve-frames.wgsl.ts";

/**
 * T1586b slice 6 — Curve Frames on a strip LONGER THAN ONE BLOCK: many walks at once.
 *
 * `curve-frames.wgsl.ts` walks a strip with one invocation, which is the right answer up to
 * 1,024 points and the wrong one at 16,000: the cost of a walk is its depth, and a walk
 * that deep is over ten milliseconds. This file is `src/points/curve.ts`'s `frameStripBlocked`
 * in WGSL, pass for pass; read its comment first. The shape:
 *
 *   1. BLOCK    one invocation per block of 1,024 points summarises its block on its own:
 *               its length, its first and last real segments, and a reference normal
 *               carried from the first to the last.
 *   2. FOLD     one invocation per STRIP walks its blocks' summaries in order — sixteen
 *               steps for 16,384 points — and leaves each block the state the whole walk
 *               would have arrived with, the turn that ends its trailing run, and the
 *               strip's length and closing angle.
 *   3. WRITE    one invocation per block walks its block again from that state and writes
 *               its points. It is the whole walk's second half, started in the middle.
 *
 * Fixed Up has two more, between 2 and 3, because it hands a second thing from point to
 * point (the normal a point takes when its tangent runs along Up):
 *
 *   2b. CHAIN       one invocation per block finds what its block does to a handed normal.
 *   2c. CHAIN FOLD  one invocation per strip hands each block the normal it starts from.
 *
 * So a long strip costs two walks of ONE block, whatever its length, plus a fold whose
 * length is the number of blocks. Nothing is written per point until the last pass, and
 * every point is written by its own block: a strip that is mostly padding is still written
 * by all its blocks at once.
 *
 * ⚑ WHY THE SUMMARY IS ENOUGH, AND WHY IT ROUNDS DIFFERENTLY. A block adds its own length
 * and turns whatever normal it is handed by its own rotation — neither depends on what came
 * before it. But a sum taken a block at a time is not the same floats as a sum taken a
 * point at a time, and a normal turned by a block's summary is not the same floats as one
 * carried across its thousand points. So a long strip differs from the same points walked
 * whole in its last bits, and the block size is part of that rounding: it is
 * `STRIP_WALK_BLOCK`, fixed, and a strip that fits one block never comes here at all.
 *
 * ## What it costs, measured
 *
 * Dawn/Metal, best of 9 runs of 200 frames, over the same graph without the node, ms per
 * frame. The rows of 1,024-point strips are the short walk, measured beside the long ones.
 *
 *   points      strips × points     blocks   Minimise Twist   metrics only   Fixed Up
 *   1,024       1 × 1,024           1        0.80             0.32           0.64
 *   4,096       1 × 4,096           4        0.97             0.49           1.27
 *   16,384      1 × 16,384          16       1.05             0.52           1.36
 *   999,424     976 × 1,024         1        1.30             0.64           1.13
 *   999,424     244 × 4,096         4        1.38             0.76           1.73
 *   999,424     61 × 16,384         16       1.41             0.78           1.77
 *   1,000,000   1 × 1,000,000       977      3.04             2.36           3.80
 *
 * A strip of 16,384 points costs a quarter more than one of 1,024, where one walk that deep
 * would cost sixteen times as much. The one figure that still follows a strip's length is
 * the last row's: the FOLD over 977 blocks is 977 steps deep, about 1.6 ms of the 3.0. A
 * fold of folds would bound it; nothing asks for it yet. Fixed Up has a third walk per
 * block, and the block pass carries the frame even when only metrics are published.
 *
 * ## The walk's scratch
 *
 * One buffer of f32 words (`walk`): two per strip, then a record per block. Vectors take
 * four words so every offset is a multiple of four. Each pass reads only what an earlier
 * pass of the same frame wrote.
 */

/** Words per strip: its length and its closing angle. */
const STRIP_WORDS = 4;
/** Words per block. */
const BLOCK_WORDS = 56;

/** Where each field of a block's record sits, in words from the record's start. */
const AT = {
  // Pass 1 — the block on its own.
  LENGTH: 0,
  HAS: 1,
  FLIP: 2,
  FIRST: 4,
  LAST: 8,
  REFERENCE: 12,
  // Fold — the state the block is entered with, and what ends its trailing run.
  TRAVELLED: 16,
  STARTED: 17,
  PREVIOUS: 20,
  CARRIED: 24,
  TAIL_TANGENT: 28,
  TAIL_BEND: 31,
  TAIL_NORMAL: 32,
  TAIL_TRAVELLED: 35,
  // Fixed Up — what the block does to a handed normal, and the one it is handed.
  DECIDED: 36,
  KNOWN: 37,
  CHAIN: 40,
  HANDED: 52,
} as const;

/** How many f32 words the walk's scratch holds for `rows` strips of `blocks` blocks each. */
export function curveFramesWalkWords(rows: number, blocks: number): number {
  return rows * STRIP_WORDS + rows * blocks * BLOCK_WORDS;
}

/**
 * Fixed Up: what the chain fold left one block — the normal it is handed, and whether that
 * is known or has to be walked to. For the tests that hold the fold itself: a wrong map
 * would still give right points (the write pass walks to what it is not told), only at the
 * cost of a walk as deep as the run, which no point's value shows.
 */
export function curveFramesHandedAt(
  walk: Float32Array,
  rows: number,
  blocks: number,
  strip: number,
  block: number,
): { readonly normal: [number, number, number]; readonly known: boolean } {
  const at = rows * STRIP_WORDS + (strip * blocks + block) * BLOCK_WORDS;
  return {
    normal: [walk[at + AT.HANDED] as number, walk[at + AT.HANDED + 1] as number, walk[at + AT.HANDED + 2] as number],
    known: walk[at + AT.KNOWN] === 1,
  };
}

/** Blocks a strip of `cols` points is cut into. */
export const curveFramesBlocks = (cols: number): number => Math.ceil(cols / STRIP_WALK_BLOCK);

const UNIFORM_TYPES = {
  up: "vec3f",
  cols: "u32",
  rows: "u32",
  closed: "u32",
  closeTwist: "u32",
  blocks: "u32",
  roll: "f32",
  twist: "f32",
} as const;

export type CurveFramesUniform = keyof typeof UNIFORM_TYPES;

/**
 * One pass of the blocked form: its text, and the uniforms its struct declares — the node
 * builds the pass's uniform record from the same list, so a member cannot be declared and
 * left unset, or set and not declared (vgpu writes uniforms by name, §V288).
 */
export interface CurveFramesBlockedPass {
  readonly shader: EmittedWgsl;
  readonly uniforms: ReadonlyArray<CurveFramesUniform>;
}

const paramsStruct = (members: ReadonlyArray<CurveFramesUniform>): string =>
  `struct CurveFramesParams {\n${members.map((member) => `  ${member}: ${UNIFORM_TYPES[member]},`).join("\n")}\n};`;

/** Bindings 1…: read-only inputs first, then the buffers the pass writes. */
const bindings = (inputs: ReadonlyArray<string>, written: ReadonlyArray<string>): string =>
  [
    "@group(0) @binding(0) var<uniform> params: CurveFramesParams;",
    ...inputs.map((input, index) => `@group(0) @binding(${index + 1}) var<storage, read> ${input};`),
    ...written.map((buffer, index) => `@group(0) @binding(${inputs.length + index + 1}) var<storage, read_write> ${buffer};`),
  ].join("\n");

const WALK = "walk: array<f32>";
const POSITION = "in_position: array<vec3f>";

/** Reading the walk's scratch. `storeVec` is only in the passes that may write it. */
const walkAccess = (writes: boolean): string => `/* A strip is cut into blocks of this many points; the last may be shorter. */
const BLOCK: u32 = ${STRIP_WALK_BLOCK}u;

/* The walk's scratch: a few words per strip, then one record per block. */
fn stripAt(strip: u32) -> u32 {
  return strip * ${STRIP_WORDS}u;
}

fn blockAt(strip: u32, blockIndex: u32) -> u32 {
  return params.rows * ${STRIP_WORDS}u + (strip * params.blocks + blockIndex) * ${BLOCK_WORDS}u;
}

fn loadVec(at: u32) -> vec3f {
  return vec3f(walk[at], walk[at + 1u], walk[at + 2u]);
}
${
  writes
    ? `
fn storeVec(at: u32, v: vec3f) {
  walk[at] = v.x;
  walk[at + 1u] = v.y;
  walk[at + 2u] = v.z;
}
`
    : ""
}
/* A real segment's direction, by the walk's own expression. */
fn dirOf(seg: vec3f) -> vec3f {
  return seg / sqrt(dot(seg, seg));
}`;

/** The inputs a pass needs to know which way a strip's first frame leans: `in_up` or `in_seed`, or neither. */
const leanInputs = (options: CurveFramesShaderOptions): string[] =>
  curveFramesTerms(options).inputs.filter((input) => !input.startsWith("in_roll"));

/**
 * `walkBlock`: one block's runs, in order, from the state the fold left it — the whole
 * walk's second half, started in the middle. `run` says what is done with each run.
 */
function walkBlockWgsl(
  wanted: string,
  parameters: string,
  totals: boolean,
  run: (first: string, last: string, tangent: string, normal: string, travelled: string, bend: string) => string,
): string {
  return `fn walkBlock(strip: u32, blockIndex: u32, ${parameters}) {
  let cols = params.cols;
  let base = strip * cols;
  var segments = cols - 1u;
  if (params.closed == 1u) { segments = cols; }
  let at = blockAt(strip, blockIndex);${
    totals
      ? `
  let total = walk[stripAt(strip)];
  let closing = walk[stripAt(strip) + 1u];`
      : ""
  }
  let first = blockIndex * BLOCK;
  let last = min(first + BLOCK, cols);
  let wanted = ${wanted};
  var started = walk[at + ${AT.STARTED}u] == 1.0;
  var prevSeg = loadVec(at + ${AT.PREVIOUS}u);
  var prevDir = vec3f(0.0, 0.0, 1.0);
  if (started) { prevDir = dirOf(prevSeg); }
  var carriedNormal = loadVec(at + ${AT.CARRIED}u);
  let entered = walk[at + ${AT.TRAVELLED}u];
  var runStart = first;
  var inside = 0.0;
  for (var k = first; k < last; k = k + 1u) {
    if (k >= segments) { break; }
    let seg = in_position[base + (k + 1u) % cols] - in_position[base + k];
    let squared = dot(seg, seg);
    if (squared <= ZERO_SEGMENT_SQUARED) { continue; }
    let size = sqrt(squared);
    let dir = seg / size;
    if (!started) {
      let seed = seedNormal(dir, wanted);
      ${run("runStart", "k", "dir", "seed", "entered + inside", "0.0")}
      carriedNormal = seed;
      started = true;
    } else {
      let crossing = turn(prevDir, dir, carriedNormal);
      ${run("runStart", "k", "crossing.tangent", "crossing.normal", "entered + inside", "turningCurvature(prevSeg, seg)")}
      carriedNormal = crossing.next;
    }
    inside = inside + size;
    prevDir = dir;
    prevSeg = seg;
    runStart = k + 1u;
  }
  if (runStart < last) {
    /* The points after the block's last real segment: a run that ends blocks away, or at
       the strip's end. The fold left the turn that ends it. */
    ${run("runStart", "last - 1u", `loadVec(at + ${AT.TAIL_TANGENT}u)`, `loadVec(at + ${AT.TAIL_NORMAL}u)`, `walk[at + ${AT.TAIL_TRAVELLED}u]`, `walk[at + ${AT.TAIL_BEND}u]`)}
  }
}`;
}

/** Pass 1 — BLOCK: every block summarised on its own. */
export function curveFramesBlockWgsl(options: CurveFramesShaderOptions): CurveFramesBlockedPass {
  const uniforms: CurveFramesUniform[] = ["up", "cols", "rows", "closed", "blocks"];
  const { wanted } = curveFramesTerms(options);
  return {
    uniforms,
    shader: wgsl`${paramsStruct(uniforms)}

${bindings([POSITION, ...leanInputs(options)], [WALK])}

${FRAME_MATH_WGSL}

${walkAccess(true)}

/* One invocation per BLOCK: nothing here depends on the blocks before it. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.rows * params.blocks) {
    return;
  }
  let strip = gid.x / params.blocks;
  let blockIndex = gid.x % params.blocks;
  let cols = params.cols;
  let base = strip * cols;
  var segments = cols - 1u;
  if (params.closed == 1u) { segments = cols; }
  let first = blockIndex * BLOCK;
  let last = min(first + BLOCK, cols);
  let wanted = ${wanted};

  var span = 0.0;
  var has = false;
  var flip = 1.0;
  var firstSeg = vec3f(0.0);
  var lastSeg = vec3f(0.0);
  var lastDir = vec3f(0.0, 0.0, 1.0);
  /* A reference normal of the block's own: seeded on its first real segment, carried to
     its last. The fold turns the normal the block is handed by the same amount. */
  var carriedRef = vec3f(0.0, 1.0, 0.0);
  for (var k = first; k < last; k = k + 1u) {
    if (k >= segments) { break; }
    let seg = in_position[base + (k + 1u) % cols] - in_position[base + k];
    let squared = dot(seg, seg);
    if (squared <= ZERO_SEGMENT_SQUARED) { continue; }
    let size = sqrt(squared);
    let dir = seg / size;
    span = span + size;
    if (!has) {
      has = true;
      firstSeg = seg;
      carriedRef = seedNormal(dir, wanted);
    } else {
      /* An exact reversal keeps the normal and turns the direction round: the side the
         reference is carried on is mirrored. */
      if (dot(lastDir, dir) < -0.999999) { flip = -flip; }
      carriedRef = turn(lastDir, dir, carriedRef).next;
    }
    lastDir = dir;
    lastSeg = seg;
  }

  let at = blockAt(strip, blockIndex);
  walk[at + ${AT.LENGTH}u] = span;
  walk[at + ${AT.HAS}u] = select(0.0, 1.0, has);
  walk[at + ${AT.FLIP}u] = flip;
  storeVec(at + ${AT.FIRST}u, firstSeg);
  storeVec(at + ${AT.LAST}u, lastSeg);
  storeVec(at + ${AT.REFERENCE}u, carriedRef);
}`,
  };
}

/** Pass 2 — FOLD: one invocation per strip walks its blocks' summaries. */
export function curveFramesFoldWgsl(options: CurveFramesShaderOptions): CurveFramesBlockedPass {
  const { carried, wanted, restDirection } = curveFramesTerms(options);
  const uniforms: CurveFramesUniform[] = carried ? ["up", "cols", "rows", "closed", "closeTwist", "blocks"] : ["up", "cols", "rows", "closed", "blocks"];
  /* How far the carried frame has turned after one lap of a closed strip. */
  const lap = carried
    ? `
  if (closed && params.closeTwist == 1u) {
    var lapNormal = seed;
    var lapDir = firstDir;
    var entered = false;
    for (var b = 0u; b < params.blocks; b = b + 1u) {
      let at = blockAt(strip, b);
      if (walk[at + ${AT.HAS}u] != 1.0) { continue; }
      var onFirst = seed;
      if (entered) { onFirst = turn(lapDir, dirOf(loadVec(at + ${AT.FIRST}u)), lapNormal).next; }
      lapNormal = through(at, onFirst, wanted);
      lapDir = dirOf(loadVec(at + ${AT.LAST}u));
      entered = true;
    }
    let lapped = turn(lastDir, firstDir, lapNormal).next;
    closing = atan2(dot(cross(seed, lapped), firstDir), dot(seed, lapped));
  }`
    : "";
  const closedStart = carried ? "\n  if (closed) { normal = turn(firstDir, lastDir, seed).next; }" : "";
  return {
    uniforms,
    shader: wgsl`${paramsStruct(uniforms)}

${bindings(leanInputs(options), [WALK])}

${FRAME_MATH_WGSL}

${walkAccess(true)}

/* A block's own turn, applied to the normal on its first segment: the normal on its last.
   Carrying a normal across a point is a rotation, so the normal a block is handed keeps its
   angle to the block's reference all the way through. */
fn through(at: u32, onFirst: vec3f, wanted: vec3f) -> vec3f {
  let incoming = dirOf(loadVec(at + ${AT.FIRST}u));
  let outgoing = dirOf(loadVec(at + ${AT.LAST}u));
  let start = seedNormal(incoming, wanted);
  let carriedRef = loadVec(at + ${AT.REFERENCE}u);
  let along = dot(onFirst, start);
  let across = dot(onFirst, cross(incoming, start)) * walk[at + ${AT.FLIP}u];
  let out = perpendicular(carriedRef * along + cross(outgoing, carriedRef) * across, outgoing);
  return out / sqrt(dot(out, out));
}

/* One invocation per STRIP. Its loops run over blocks, not points. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strip = gid.x;
  if (strip >= params.rows) {
    return;
  }
  let base = strip * params.cols;
  let closed = params.closed == 1u;
  let wanted = ${wanted};

  /* The strip's length, each block's start, and the first and last real segments. */
  var total = 0.0;
  var found = false;
  var firstSeg = vec3f(0.0);
  var lastSeg = vec3f(0.0);
  for (var b = 0u; b < params.blocks; b = b + 1u) {
    let at = blockAt(strip, b);
    walk[at + ${AT.TRAVELLED}u] = total;
    total = total + walk[at + ${AT.LENGTH}u];
    if (walk[at + ${AT.HAS}u] == 1.0) {
      if (!found) {
        found = true;
        firstSeg = loadVec(at + ${AT.FIRST}u);
      }
      lastSeg = loadVec(at + ${AT.LAST}u);
    }
  }
  walk[stripAt(strip)] = total;
  walk[stripAt(strip) + 1u] = 0.0;

  if (!found) {
    /* A strip of no length has no direction: its frame is the seed's, its metrics zero.
       Every block is one run, and this is what it is written with. */
    let rest = ${restDirection};
    let still = seedNormal(rest, wanted);
    for (var b = 0u; b < params.blocks; b = b + 1u) {
      let at = blockAt(strip, b);
      walk[at + ${AT.STARTED}u] = 0.0;
      storeVec(at + ${AT.PREVIOUS}u, vec3f(0.0));
      storeVec(at + ${AT.CARRIED}u, still);
      storeVec(at + ${AT.TAIL_TANGENT}u, rest);
      walk[at + ${AT.TAIL_BEND}u] = 0.0;
      storeVec(at + ${AT.TAIL_NORMAL}u, still);
      walk[at + ${AT.TAIL_TRAVELLED}u] = 0.0;
    }
    return;
  }

  let firstDir = dirOf(firstSeg);
  let lastDir = dirOf(lastSeg);
  let seed = seedNormal(firstDir, wanted);
  var closing = 0.0;${lap}
  walk[stripAt(strip) + 1u] = closing;

  /* Forward: the state each block is entered with. A closed strip starts from the last
     segment's frame as it was BEFORE the lap. */
  var started = closed;
  var prevSeg = lastSeg;
  var normal = seed;${closedStart}
  for (var b = 0u; b < params.blocks; b = b + 1u) {
    let at = blockAt(strip, b);
    walk[at + ${AT.STARTED}u] = select(0.0, 1.0, started);
    storeVec(at + ${AT.PREVIOUS}u, prevSeg);
    storeVec(at + ${AT.CARRIED}u, normal);
    if (walk[at + ${AT.HAS}u] != 1.0) { continue; }
    var onFirst = seed;
    if (started) { onFirst = turn(dirOf(prevSeg), dirOf(loadVec(at + ${AT.FIRST}u)), normal).next; }
    normal = through(at, onFirst, wanted);
    prevSeg = loadVec(at + ${AT.LAST}u);
    started = true;
  }

  /* Backward: the turn that ends each block's trailing run is the one that opens the next
     block with a real segment — or the strip's own end. */
  var tailTangent = dirOf(prevSeg);
  var tailNormal = normal;
  var tailBend = 0.0;
  var tailTravelled = total;
  if (closed) {
    let crossing = turn(dirOf(prevSeg), firstDir, normal);
    tailTangent = crossing.tangent;
    tailNormal = crossing.normal;
    tailBend = turningCurvature(prevSeg, firstSeg);
  }
  for (var n = params.blocks; n > 0u; n = n - 1u) {
    let at = blockAt(strip, n - 1u);
    storeVec(at + ${AT.TAIL_TANGENT}u, tailTangent);
    walk[at + ${AT.TAIL_BEND}u] = tailBend;
    storeVec(at + ${AT.TAIL_NORMAL}u, tailNormal);
    walk[at + ${AT.TAIL_TRAVELLED}u] = tailTravelled;
    if (walk[at + ${AT.HAS}u] != 1.0) { continue; }
    let opening = loadVec(at + ${AT.FIRST}u);
    tailTravelled = walk[at + ${AT.TRAVELLED}u];
    if (walk[at + ${AT.STARTED}u] == 1.0) {
      let entry = loadVec(at + ${AT.PREVIOUS}u);
      let crossing = turn(dirOf(entry), dirOf(opening), loadVec(at + ${AT.CARRIED}u));
      tailTangent = crossing.tangent;
      tailNormal = crossing.normal;
      tailBend = turningCurvature(entry, opening);
    } else {
      tailTangent = dirOf(opening);
      tailNormal = seed;
      tailBend = 0.0;
    }
  }
}`,
  };
}

/** Pass 2b — CHAIN (Fixed Up): what each block does to the normal handed from point to point. */
export function curveFramesChainWgsl(options: CurveFramesShaderOptions): CurveFramesBlockedPass {
  const uniforms: CurveFramesUniform[] = ["up", "cols", "rows", "closed", "blocks"];
  const { wanted, upAt } = curveFramesTerms(options);
  return {
    uniforms,
    shader: wgsl`${paramsStruct(uniforms)}

${bindings([POSITION, ...leanInputs(options)], [WALK])}

${FRAME_MATH_WGSL}

${walkAccess(true)}

/* A block's part in the chain. Once one of its points has decided a normal of its own
   (decided), what the block hands on is that chain's last normal and owes nothing to the
   blocks before it. Until then it is the handed normal pressed square to each tangent in
   turn — a linear map, kept as where it sends the three axes. */
struct Chain {
  decided: bool,
  seen: bool,
  own: vec3f,
  x: vec3f,
  y: vec3f,
  z: vec3f,
};

fn chainRun(base: u32, first: u32, last: u32, tangent: vec3f, state: ptr<function, Chain>) {
  for (var i = first; i <= last; i = i + 1u) {
    let slot = base + i;
    var leaning = perpendicular(${upAt}, tangent);
    if (dot(leaning, leaning) < 1.0e-12) {
      if ((*state).decided) {
        leaning = perpendicular((*state).own, tangent);
      } else if ((*state).seen) {
        (*state).x = perpendicular((*state).x, tangent);
        (*state).y = perpendicular((*state).y, tangent);
        (*state).z = perpendicular((*state).z, tangent);
        continue;
      }
    }
    if (dot(leaning, leaning) < 1.0e-12) { leaning = perpendicular(leastAligned(tangent), tangent); }
    (*state).own = leaning / sqrt(dot(leaning, leaning));
    (*state).decided = true;
    (*state).seen = true;
  }
}

${walkBlockWgsl(wanted, "state: ptr<function, Chain>", false, (first, last, tangent) => `chainRun(base, ${first}, ${last}, ${tangent}, state);`)}

/* One invocation per BLOCK. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.rows * params.blocks) {
    return;
  }
  let strip = gid.x / params.blocks;
  let blockIndex = gid.x % params.blocks;
  /* The strip's very first point has nothing before it: it always decides. */
  var state = Chain(false, blockIndex > 0u, vec3f(0.0), vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0));
  walkBlock(strip, blockIndex, &state);
  let at = blockAt(strip, blockIndex);
  if (state.decided) {
    walk[at + ${AT.DECIDED}u] = 1.0;
    storeVec(at + ${AT.CHAIN}u, state.own);
  } else {
    walk[at + ${AT.DECIDED}u] = 0.0;
    storeVec(at + ${AT.CHAIN}u, state.x);
    storeVec(at + ${AT.CHAIN + 4}u, state.y);
    storeVec(at + ${AT.CHAIN + 8}u, state.z);
  }
}`,
  };
}

/** Pass 2c — CHAIN FOLD (Fixed Up): the normal each block is handed. */
export function curveFramesChainFoldWgsl(): CurveFramesBlockedPass {
  const uniforms: CurveFramesUniform[] = ["rows", "blocks"];
  return {
    uniforms,
    shader: wgsl`${paramsStruct(uniforms)}

${bindings([], [WALK])}

${walkAccess(true)}

/* One invocation per STRIP, over its blocks. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let strip = gid.x;
  if (strip >= params.rows) {
    return;
  }
  var handed = vec3f(0.0);
  var known = true;
  for (var b = 0u; b < params.blocks; b = b + 1u) {
    let at = blockAt(strip, b);
    storeVec(at + ${AT.HANDED}u, handed);
    walk[at + ${AT.KNOWN}u] = select(0.0, 1.0, known);
    if (walk[at + ${AT.DECIDED}u] == 1.0) {
      handed = loadVec(at + ${AT.CHAIN}u);
      known = true;
    } else if (known) {
      let mapped = loadVec(at + ${AT.CHAIN}u) * handed.x + loadVec(at + ${AT.CHAIN + 4}u) * handed.y + loadVec(at + ${AT.CHAIN + 8}u) * handed.z;
      /* Every pressing can only shorten it. Still a millionth of its length: no single
         pressing can have collapsed it, so the chain inside ran unbroken and this is it.
         Shorter, and it MAY have restarted from a world axis in there — which a summary
         cannot say, so what follows is marked not known and walked. */
      if (dot(mapped, mapped) >= 1.0e-12) {
        handed = mapped / sqrt(dot(mapped, mapped));
      } else {
        known = false;
      }
    }
  }
}`,
  };
}

/** Pass 3 — WRITE: every block walks again from its entry and writes its own points. */
export function curveFramesWriteWgsl(options: CurveFramesShaderOptions): CurveFramesBlockedPass {
  const uniforms: CurveFramesUniform[] = ["up", "cols", "rows", "closed", "blocks", "roll", "twist"];
  const terms = curveFramesTerms(options);
  /* Fixed Up: start from the last block whose handed normal is known — this one, on any
     real curve — and walk forward to this block, writing only here. */
  const handed = terms.carried
    ? ""
    : `
  var start = blockIndex;
  while (start > 0u && walk[blockAt(strip, start) + ${AT.KNOWN}u] == 0.0) {
    start = start - 1u;
  }
  previous = loadVec(blockAt(strip, start) + ${AT.HANDED}u);
  seen = start > 0u;
  for (var c = start; c < blockIndex; c = c + 1u) {
    walkBlock(strip, c, false, &previous, &seen);
  }`;
  return {
    uniforms,
    shader: wgsl`${paramsStruct(uniforms)}

${bindings([POSITION, ...terms.inputs, WALK], ["out_points: array<u32>"])}

${options.storeFunctions}

${FRAME_MATH_WGSL}

${walkAccess(false)}

${writeRunWgsl(terms, options.storeStatements, true)}

${walkBlockWgsl(
  terms.wanted,
  "emit: bool, previous: ptr<function, vec3f>, seen: ptr<function, bool>",
  true,
  (first, last, tangent, normal, travelled, bend) =>
    `writeRun(base, ${first}, ${last}, ${tangent}, ${normal}, ${travelled}, total, closing, ${bend}, previous, seen, emit);`,
)}

/* One invocation per BLOCK, writing that block's points and no others. */
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.rows * params.blocks) {
    return;
  }
  let strip = gid.x / params.blocks;
  let blockIndex = gid.x % params.blocks;
  var previous = vec3f(0.0);
  var seen = false;${handed}
  walkBlock(strip, blockIndex, true, &previous, &seen);
}`,
  };
}
