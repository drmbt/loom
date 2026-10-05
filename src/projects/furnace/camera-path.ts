import type { FurnaceSceneFacts } from "./scene-facts.ts";

/**
 * T1354b — the CAMERA PATH: a cut list over the Blender framings, each shot a MOVE.
 *
 * Every shot starts from its `shot.*` camera and moves in that camera's own frame — dolly
 * (along its view), truck (sideways), crane (up), push (fov) or orbit (around its aim) —
 * eased across the shot, centred on the authored pose so the framing the Blender pass
 * composed is the middle of the move. Cuts land on bar lines of the track's tempo.
 *
 * It is emitted as EXPRESSIONS of a time term, so the same path evaluated at
 * `(abstime - delta)` is the PREVIOUS frame's camera — what the motion blur reprojects
 * with — exactly, deterministically, with no stored state. When the director (§T1370b)
 * chooses shots from the music, the path stops being a function of time alone and the
 * previous camera comes from a one-frame delay instead.
 */

type Vec3 = readonly [number, number, number];

/** A framing built in code from the plant's own markers and pivots, not authored in Blender. */
interface Pose {
  readonly eye: Vec3;
  readonly aim: Vec3;
  readonly fov: number;
}

interface Move {
  /** A Blender `shot.*` camera, or {@link Move.pose}. */
  readonly shot?: string;
  readonly pose?: (facts: FurnaceSceneFacts) => Pose;
  /** Name, for a pose (a Blender shot is named by its camera). */
  readonly name?: string;
  readonly dolly?: number;
  readonly truck?: number;
  readonly crane?: number;
  /** FOV change across the move, degrees (negative pushes in). */
  readonly push?: number;
  /** Radians around the aim point, about world Y. */
  readonly orbit?: number;
  /** A DOLLY ZOOM: metres backwards (negative) or in, the lens narrowing to hold the subject's size. */
  readonly vertigo?: number;
  /** smooth: in-and-out; whip: fast off the cut, settling; creep: constant, relentless. */
  readonly ease?: "smooth" | "whip" | "creep";
  /** Degrees of ROLL across the move (360 = a barrel roll), centred on the framing. */
  readonly roll?: number;
  /** How deep the sightline must be clear, metres (a scale shot looks THROUGH the plant). */
  readonly foreground?: number;
  /** Rides a crane bridge along X (the rig's travel parameter). */
  readonly follow?: "craneX" | "crane2X";
}

const toward = (eye: Vec3, aim: Vec3, fov: number): Pose => ({ eye, aim, fov });
const at = (facts: FurnaceSceneFacts, name: string): Vec3 => {
  const marker = facts.markers.get(name);
  if (marker !== undefined) return marker.position;
  const part = facts.parts.get(name);
  if (part !== undefined) return part.pivot;
  throw new Error(`cameraPath: no marker or part "${name}" in the GLB.`);
};
const offset = (base: Vec3, by: Vec3): Vec3 => [base[0] + by[0], base[1] + by[1], base[2] + by[2]];

/**
 * A framing that FINDS its eye: the subject (a marker or part, nudged by `lift`) seen from the
 * first candidate offset whose sightline is clear for three-quarters of the way — so a
 * re-export that moves a column moves the camera, instead of parking it behind the column.
 */
/** The hall's inside, from tools/blender/furnace/layout.py (HX ±60, HY 17; the eaves below the roof trusses). */
const HALL_HALF_LENGTH = 60;
const HALL_HALF_WIDTH = 17;
const HALL_EAVES = 30;

/** `foreground`: how deep the frame must be clear, metres — a scale shot WANTS the plant between it and its subject, only not in its lap. */
const seek = (subject: string, lift: Vec3, fov: number, candidates: readonly Vec3[], ringed = true, foreground = Infinity) => (facts: FurnaceSceneFacts): Pose => {
  const aim = offset(at(facts, subject), lift);
  // The given candidates first, in order; then a ring at their distances and heights, every 15°.
  const ring: Vec3[] = [];
  for (const candidate of ringed ? candidates : []) {
    const radius = Math.hypot(candidate[0], candidate[2]);
    for (let angle = 0; angle < 360; angle += 15) {
      ring.push([Math.cos((angle * Math.PI) / 180) * radius, candidate[1], Math.sin((angle * Math.PI) / 180) * radius]);
    }
  }
  for (const candidate of [...candidates, ...ring]) {
    const eye = offset(aim, candidate);
    // Inside the building: an eye past a wall films the wall's outside.
    if (Math.abs(eye[0]) > HALL_HALF_LENGTH - 1 || Math.abs(eye[2]) > HALL_HALF_WIDTH - 1 || eye[1] > HALL_EAVES) continue;
    // Clear down the centre AND toward the frame's inner half on all four sides: a column
    // beside the subject is as bad as one in front of it.
    const d: Vec3 = [aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]];
    const reach = Math.hypot(d[0], d[1], d[2]);
    const flat = Math.hypot(d[0], d[2]) || 1;
    const right: Vec3 = [-d[2] / flat, 0, d[0] / flat];
    const spread = reach * Math.tan((fov * Math.PI) / 360) * 0.5;
    const targets: Vec3[] = [aim, offset(aim, [right[0] * spread, 0, right[2] * spread]), offset(aim, [-right[0] * spread, 0, -right[2] * spread]), offset(aim, [0, spread, 0]), offset(aim, [0, -spread, 0])];
    const clear = targets.every((target) => {
      const share = Math.min(0.75, foreground / Math.max(reach, 1e-3));
      const near: Vec3 = [eye[0] + (target[0] - eye[0]) * share, eye[1] + (target[1] - eye[1]) * share, eye[2] + (target[2] - eye[2]) * share];
      return firstHit(facts.blockers, eye, near) >= 1;
    });
    if (clear) return toward(eye, aim, fov);
  }
  throw new Error(`cameraPath: no clear eye on "${subject}" among ${candidates.length} candidates and their rings.`);
};

/**
 * DISCOVERED framings: instead of hand-placing every angle, search the hall. Candidate eyes on
 * a grid through the whole building (floor level to the crane rails) look at each point of
 * interest — the process — and are scored by what a frame of it would show:
 *
 *  - the subject must be in clear sight and the foreground clear;
 *  - every OTHER point of interest also in shot adds (layering — the plant in depth);
 *  - an unconventional angle adds: very low, very high, or steeply up or down;
 *  - distance costs a little.
 *
 * The best are taken greedily, no two eyes within 12 m and each subject once, so the
 * set spreads over the hall. Build-time only, from the plant's own geometry.
 */
// The HOT points only: a frame built on an unlit subject is a black frame.
const INTEREST = [
  "emit.slag_door", "emit.ladle_surface", "emit.slag_pot_surface", "emit.tundish_pour", "emit.caster_mould",
  "emit.furnace_mouth", "emit.slag_fall",
] as const;
export const DISCOVERED = 6;
let discoveredCache: { key: FurnaceSceneFacts; poses: Pose[] } | undefined;

function discover(facts: FurnaceSceneFacts): Pose[] {
  if (discoveredCache?.key === facts) return discoveredCache.poses;
  const targets = INTEREST.flatMap((name) => (facts.markers.has(name) ? [at(facts, name)] : []));
  const clear = (from: Vec3, to: Vec3, share: number): boolean =>
    firstHit(facts.blockers, from, [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share, from[2] + (to[2] - from[2]) * share]) >= 1;
  const scored: Array<{ eye: Vec3; aim: Vec3; target: number; score: number }> = [];
  for (let x = -54; x <= 54; x += 6) {
    for (let z = -14; z <= 14; z += 7) {
      for (const y of [0.8, 3, 8, 14, 20, 26]) {
        const eye: Vec3 = [x, y, z];
        // Room around the lens: nothing within 1.5 m in any of 14 directions (inside a machine,
        // against a wall or a window pane, the frame is one flat colour).
        const room = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]
          .every(([a, b, c]) => { const k = 1.5 / Math.hypot(a!, b!, c!); return clear(eye, [x + a! * k, y + b! * k, z + c! * k], 1); });
        if (!room) continue;
        targets.forEach((target, t) => {
          const d: Vec3 = [target[0] - x, target[1] - y, target[2] - z];
          const dist = Math.hypot(d[0], d[1], d[2]);
          if (dist < 8 || dist > 28) return;
          if (!clear(eye, target, 0.97)) return;
          // Foreground: 6 m clear straight ahead and toward the frame's sides.
          const flat = Math.hypot(d[0], d[2]) || 1;
          const side: Vec3 = [-d[2] / flat, 0, d[0] / flat];
          const ahead = (sx: number, sy: number): Vec3 => [x + (d[0] / dist + side[0] * sx) * 6, y + (d[1] / dist + sy) * 6, z + (d[2] / dist + side[2] * sx) * 6];
          if (![[0, 0], [0.35, 0], [-0.35, 0], [0, 0.2], [0, -0.2]].every(([sx, sy]) => clear(eye, ahead(sx!, sy!), 1))) return;
          let context = 0;
          targets.forEach((other, o) => {
            if (o === t) return;
            const e: Vec3 = [other[0] - x, other[1] - y, other[2] - z];
            const len = Math.hypot(e[0], e[1], e[2]);
            const cos = (e[0] * d[0] + e[1] * d[1] + e[2] * d[2]) / (len * dist);
            if (cos > Math.cos((24 * Math.PI) / 180) && len < 60 && clear(eye, other, 0.97)) context += 1;
          });
          const pitch = Math.asin(d[1] / dist);
          const unconventional = (y < 1.5 ? 1 : 0) + (y > 18 ? 1 : 0) + (Math.abs(pitch) > 0.6 ? 1 : 0);
          scored.push({ eye, aim: target, target: t, score: 1 + context * 1.2 + unconventional * 0.8 - dist / 25 });
        });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked: typeof scored = [];
  // Where the move assigned to the next pick ends must be as clear as where it starts.
  const endOf = (candidate: (typeof scored)[number], move: Omit<Move, "pose" | "name">): Vec3 => {
    const e = candidate.eye, a = candidate.aim;
    const d: Vec3 = [a[0] - e[0], a[1] - e[1], a[2] - e[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const f: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
    const flat = Math.hypot(f[0], f[2]) || 1;
    const r: Vec3 = [-f[2] / flat, 0, f[0] / flat];
    const turn = (move.orbit ?? 0) * 0.5;
    const ox = e[0] - a[0], oz = e[2] - a[2];
    const orbited: Vec3 = [a[0] + ox * Math.cos(turn) + oz * Math.sin(turn), e[1], a[2] - ox * Math.sin(turn) + oz * Math.cos(turn)];
    const k = 0.5;
    return [orbited[0] + (f[0] * (move.dolly ?? 0) + r[0] * (move.truck ?? 0)) * k, orbited[1] + (f[1] * (move.dolly ?? 0) + (move.crane ?? 0)) * k, orbited[2] + (f[2] * (move.dolly ?? 0) + r[2] * (move.truck ?? 0)) * k];
  };
  // Each subject once; if some subject has no clear framing, a second framing of another fills.
  for (const perSubject of [1, 2]) {
    for (const candidate of scored) {
      if (picked.length === DISCOVERED) break;
      if (picked.includes(candidate)) continue;
      const move = DISCOVERED_MOVES[picked.length % DISCOVERED_MOVES.length]!;
      const end = endOf(candidate, move);
      if (!clear(candidate.eye, end, 1) || !clear(end, candidate.aim, 0.9)) continue;
      if (picked.some((p) => Math.hypot(p.eye[0] - candidate.eye[0], p.eye[1] - candidate.eye[1], p.eye[2] - candidate.eye[2]) < 12)) continue;
      if (picked.filter((p) => p.target === candidate.target).length >= perSubject) continue;
      picked.push(candidate);
    }
  }
  if (picked.length < DISCOVERED) throw new Error(`cameraPath: the hall search found only ${picked.length} of ${DISCOVERED} framings.`);
  const poses = picked.map((p) => toward(p.eye, p.aim, p.eye[1] > 18 || p.eye[1] < 1.5 ? 58 : 44));
  discoveredCache = { key: facts, poses };
  return poses;
}

/** Drone moves for the discovered framings, in turn: a push with a bank, a rising reveal, an orbit, a banking drift. */
const DISCOVERED_MOVES: ReadonlyArray<Omit<Move, "pose" | "name">> = [
  { dolly: 9, roll: -22, ease: "smooth" },
  { crane: 5, dolly: 3, roll: 12, ease: "whip" },
  { orbit: 0.7, roll: -8, ease: "creep" },
  { truck: 7, dolly: 4, roll: 25, ease: "smooth" },
];

/**
 * Every framing with its move, CLOSE pool first, WIDE pool after — the director (§T1370b)
 * picks from the close, dynamic set when the music is energetic and from the wide, slow set
 * when it is not, by index range; the time-driven cut plays them in this order. The close
 * pool opens with the HOT shots — the melt, the pour, the tap, the slag — because orange
 * light in black steel is what this film is.
 */
export const CUT: readonly Move[] = [
  // The hall search's framings (discover()), each flown as a drone move.
  ...Array.from({ length: DISCOVERED }, (_, k): Move => ({
    name: `discovered_${k}`,
    pose: (f) => discover(f)[k]!,
    foreground: 6,
    ...DISCOVERED_MOVES[k % DISCOVERED_MOVES.length]!,
  })),
  // Hot: looking INTO the process.
  // Into the furnace through the slag door, a long lens from the dark: the bath inside.
  { name: "slag_door_into", pose: seek("emit.slag_door", [0, -0.3, 0], 20, [
    // The door faces −X: only eyes on that side see INTO the furnace.
    [-14, 0.5, 2], [-14, 0.5, -2], [-12, -0.5, 4], [-12, -0.5, -4], [-17, 1.5, 0], [-10, -1, 5], [-10, -1, -5], [-18, 2.5, 3], [-18, 2.5, -3], [-9, 0, 2], [-9, 0, -2], [-8, -1, 0],
  ], false), push: -4, dolly: 2, ease: "creep" },
  // The slag falling into the pot.
  { name: "slag_fall", pose: seek("emit.slag_fall", [0, 0.5, 0], 40, [[-5, -1.5, 5], [-5, -1.5, -5], [-6, 0, 3], [-4, -2, 6]]), dolly: 2.5, ease: "whip" },
  // The slag pot, brimming: a crusted black surface cracked open to orange.
  { name: "slag_pot", pose: seek("emit.slag_pot_surface", [0, 0, 0], 36, [[-4, 4, 4], [-4, 4, -4], [-5, 3, 0], [-3, 5, 5], [0, 5, 5]]), crane: 1, ease: "creep" },
  // Dynamic.
  { shot: "shot.hero_low_furnace", dolly: 4.0, crane: 1.5, ease: "whip" },
  { name: "electrode_orbit", pose: (f) => toward(offset(at(f, "electrode_2"), [11, 8, 9]), offset(at(f, "electrode_2"), [0, 5, 0.3]), 26), orbit: 1.3, ease: "creep" },
  // The ELECTRODES from the side at roof level: three columns pumping into the roof, their
  // ports burning — the machine's heartbeat, from where the pumping reads.
  { name: "electrodes_side", pose: seek("electrode_2", [0, 7, 0], 40, [[10, 1.5, 6], [-10, 1.5, 6], [10, 1.5, -6], [6, 2, 10], [-6, 2, -10]], true, 6), foreground: 6, truck: 2, ease: "creep" },
  { name: "slag_door_vertigo", pose: (f) => toward(offset(at(f, "emit.slag_door"), [-13, -2.5, 6]), offset(at(f, "emit.slag_door"), [0, -0.5, 0]), 34), vertigo: -6, ease: "smooth" },
  { shot: "shot.caster_strand", dolly: 6.0, truck: -1.5 },
  { shot: "shot.pipe_corridor", dolly: 9.0, ease: "creep" },
  // A DRONE dropping out of the roof over the scrap bay toward the charging floor.
  { name: "drone_descend", pose: seek("emit.scrap_bucket_drop", [0, -6, 0], 60, [[-14, 12, 10], [-14, 12, -10], [-18, 10, 0], [-10, 14, 12]], false, 12), foreground: 12, crane: -7, dolly: 6, roll: -14, ease: "smooth" },
  // Across the caster from its far side, trucking along the strands.
  { name: "caster_across", pose: seek("caster_strand", [0, 0, 0], 50, [[0, 8, -20], [-8, 8, -19], [8, 7, -19], [0, 9, 9], [-18, 6, -10], [-20, 9, 0]], true, 12), foreground: 12, dolly: 4, ease: "creep" },
  // A BARREL ROLL down the melt bay: flying the length of the hall at gantry height, the
  // whole plant turning over once around the lens.
  { name: "barrel_fly", pose: () => toward([-30, 15, -9], [30, 11, -7], 62), dolly: 30, roll: -360, ease: "smooth" },
  // Over the furnace like a drone: rising off the charging side, banking as it crosses.
  { name: "furnace_flyover", pose: seek("furnace_shell", [0, -1, 0], 55, [[-24, 8, 12], [-24, 8, -12], [24, 8, 12], [0, 9, 26], [-26, 10, 0]]), dolly: 16, crane: 3, roll: -35, ease: "creep" },
  // Wide and slow.
  { shot: "shot.establish_wide", truck: 10.0, dolly: 3.0 },
  { shot: "shot.scrap_bay", orbit: 0.45 },
  { shot: "shot.top_down", crane: -4.0, orbit: 0.8, ease: "creep" },
  { name: "roof_glide", pose: (f) => toward([-44, 25, -9], offset(at(f, "furnace_shell"), [-8, -6, 2]), 50), dolly: 18, ease: "creep" },
  // ACROSS THE HALL from the far wall's gallery: the furnace, the cranes, the caster in one line, panning.
  { name: "across_hall", pose: seek("furnace_shell", [0, -2, 0], 62, [[0, 12, -15], [0, 12, 15], [-10, 11, -15], [10, 11, 15], [-18, 13, 15], [18, 13, -15]], false, 12), foreground: 12, dolly: 5, crane: 1.5, ease: "creep" },
  // A wide ORBIT round the whole melt shop from crane height.
  { name: "plant_orbit", pose: seek("furnace_shell", [0, 0, 0], 50, [[-42, 18, 0], [0, 18, 42], [42, 18, 0], [0, 18, -42]], false, 12), foreground: 12, orbit: 0.5, ease: "smooth" },
  // SCALE: the full length of the hall through a long lens from the floor at the scrap-bay end —
  // columns stacking, the furnace small in the middle distance, the roof lost in smoke.
  { name: "hall_length", pose: seek("furnace_shell", [0, -3, 0], 24, [[-55, -7, -8], [-50, -6, 8], [55, -7, -6], [50, -6, 8], [-40, -5, -10], [40, -5, 10]], false, 12), foreground: 12, dolly: 5, push: -3, ease: "creep" },
  // A slow flight down the hall from the scrap-bay end toward the furnace, the cranes passing.
  { name: "hall_flythrough", pose: seek("furnace_shell", [0, 2, 0], 58, [[-50, 8, 6], [-50, 8, -6], [50, 8, 6], [50, 8, -6], [-38, 10, 0], [38, 10, 0], [-30, 12, 10]], false, 12), foreground: 12, dolly: 30, roll: 18, ease: "creep" },
];

/** How many CUT entries, from the start, are HOT (the process itself); they open the close pool. */
export const HOT_POOL = 3;
/** CUT opens with the DISCOVERED framings; the hot pool starts after them. */
export const HOT_START = DISCOVERED;
/** How many CUT entries, from the start, form the close pool; the rest are the wide pool. */
export const CLOSE_POOL = 13;

/** How far ahead of a Blender shot's eye its aim point sits, metres (the orbit's pivot). */
const AIM_DISTANCE = 12;
/** How close a moving camera may come to any surface, metres. */
const CLEARANCE = 0.6;

/** Triangles the camera must not pass through: world positions (xyz) and u32 corner indices. */
export interface Blocker {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * The nearest hit of the segment from `from` to `to` against every blocker triangle, as a
 * fraction of the segment (Möller–Trumbore; 1 = clear). Build-time only — a few rays per shot
 * over the whole plant, which is what keeps a centred move from backing into a beam.
 */
/** Triangles in runs of CHUNK with the run's bounding box: a ray skips a whole run it misses. */
const CHUNK = 256;
const chunkBoxes = new WeakMap<Blocker, Float32Array>();
function boxesOf(blocker: Blocker): Float32Array {
  const cached = chunkBoxes.get(blocker);
  if (cached !== undefined) return cached;
  const { positions: p, indices } = blocker;
  const triangles = indices.length / 3;
  const boxes = new Float32Array(Math.ceil(triangles / CHUNK) * 6);
  for (let c = 0; c * CHUNK < triangles; c++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let t = c * CHUNK; t < Math.min(triangles, (c + 1) * CHUNK); t++) {
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k]! * 3;
        const x = p[v]!, y = p[v + 1]!, z = p[v + 2]!;
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
        if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
      }
    }
    boxes.set([x0, y0, z0, x1, y1, z1], c * 6);
  }
  chunkBoxes.set(blocker, boxes);
  return boxes;
}

/**
 * The nearest hit of the segment from `from` to `to` against every blocker triangle, as a
 * fraction of the segment (Möller–Trumbore; 1 = clear). Build-time only. Runs of triangles
 * whose bounding box the segment misses (slab test) are skipped whole.
 */
export function firstHit(blockers: readonly Blocker[], from: readonly number[], to: readonly number[]): number {
  const dir = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!];
  const inv = dir.map((d) => (Math.abs(d) < 1e-12 ? 1e12 : 1 / d));
  let nearest = 1;
  for (const blocker of blockers) {
    const { positions: p, indices } = blocker;
    const boxes = boxesOf(blocker);
    const triangles = indices.length / 3;
    for (let c = 0; c * CHUNK < triangles; c++) {
      let tmin = 0, tmax = nearest;
      for (let axis = 0; axis < 3 && tmin <= tmax; axis++) {
        const a = (boxes[c * 6 + axis]! - from[axis]!) * inv[axis]!;
        const b = (boxes[c * 6 + 3 + axis]! - from[axis]!) * inv[axis]!;
        tmin = Math.max(tmin, Math.min(a, b));
        tmax = Math.min(tmax, Math.max(a, b));
      }
      if (tmin > tmax) continue;
      for (let t = c * CHUNK * 3; t < Math.min(indices.length, (c + 1) * CHUNK * 3); t += 3) {
        const a = indices[t]! * 3, b = indices[t + 1]! * 3, cc = indices[t + 2]! * 3;
        const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
        const e2x = p[cc]! - p[a]!, e2y = p[cc + 1]! - p[a + 1]!, e2z = p[cc + 2]! - p[a + 2]!;
        const hx = dir[1]! * e2z - dir[2]! * e2y, hy = dir[2]! * e2x - dir[0]! * e2z, hz = dir[0]! * e2y - dir[1]! * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det;
        const sx = from[0]! - p[a]!, sy = from[1]! - p[a + 1]!, sz = from[2]! - p[a + 2]!;
        const u = (sx * hx + sy * hy + sz * hz) * id;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dir[0]! * qx + dir[1]! * qy + dir[2]! * qz) * id;
        if (v < 0 || u + v > 1) continue;
        const hit = (e2x * qx + e2y * qy + e2z * qz) * id;
        if (hit >= 0 && hit < nearest) nearest = hit;
      }
    }
  }
  return nearest;
}

/** The share (0..1) of a half-move that stays CLEARANCE away from every surface. */
function safeShare(blockers: readonly Blocker[], from: readonly number[], offset: readonly number[]): number {
  const length = Math.hypot(offset[0]!, offset[1]!, offset[2]!);
  if (length < 1e-6 || blockers.length === 0) return 1;
  const reach = (length + CLEARANCE) / length;
  const to = [from[0]! + offset[0]! * reach, from[1]! + offset[1]! * reach, from[2]! + offset[2]! * reach];
  const hit = firstHit(blockers, from, to) * (length + CLEARANCE);
  return Math.max(0, Math.min(1, (hit - CLEARANCE) / length));
}

export interface CameraPath {
  /** Seconds per shot: whole bars of the track's tempo. */
  readonly shotSeconds: number;
  readonly eye: readonly [string, string, string];
  readonly aim: readonly [string, string, string];
  readonly fov: string;
  /** Roll in degrees (T1383b). */
  readonly roll: string;
}

/** The view direction and its level right-hand side (forward × world up). */
function basis(forward: Vec3): { forward: Vec3; right: Vec3 } {
  const length = Math.hypot(forward[2], forward[0]) || 1;
  return { forward, right: [-forward[2] / length, 0, forward[0] / length] };
}

const n = (value: number): string => (Math.abs(value) < 1e-9 ? "0" : value.toFixed(4));

/** A move's framing as eye, unit forward, aim distance and lens — from Blender or from a pose. */
function framing(facts: FurnaceSceneFacts, move: Move): { eye: Vec3; forward: Vec3; reach: number; fov: number } {
  if (move.pose !== undefined) {
    const pose = move.pose(facts);
    const d: Vec3 = [pose.aim[0] - pose.eye[0], pose.aim[1] - pose.eye[1], pose.aim[2] - pose.eye[2]];
    const reach = Math.hypot(d[0], d[1], d[2]) || 1;
    // A pose must SEE its subject: the plant between eye and aim is a black frame, loudly.
    // The last quarter is the subject's own clutter (an electrode's arms, a ladle's rim).
    const share = Math.min(0.75, (move.foreground ?? Infinity) / reach);
    const near: Vec3 = [pose.eye[0] + d[0] * share, pose.eye[1] + d[1] * share, pose.eye[2] + d[2] * share];
    const hit = firstHit(facts.blockers, pose.eye, near);
    if (hit < 1) throw new Error(`cameraPath: pose "${move.name ?? "?"}" is blocked ${(hit * reach * 0.75).toFixed(1)} m from its eye, before its subject at ${reach.toFixed(1)} m.`);
    return { eye: pose.eye, forward: [d[0] / reach, d[1] / reach, d[2] / reach], reach, fov: pose.fov };
  }
  const camera = move.shot === undefined ? undefined : facts.cameras.get(move.shot);
  if (camera === undefined) throw new Error(`cameraPath: the GLB has no camera "${move.shot ?? move.name ?? "?"}".`);
  return { eye: camera.eye, forward: camera.forward, reach: AIM_DISTANCE, fov: camera.fovDeg };
}

/**
 * The path as expressions of `time` (an expression term: `abstime`, or `(abstime - delta)`
 * for the previous frame). `beatsPerMinute` and `bars` set the shot length.
 */
export function cameraPath(
  facts: FurnaceSceneFacts,
  time: string,
  beatsPerMinute: number,
  bars: number,
  blockers: readonly Blocker[] = [],
): CameraPath {
  const shotSeconds = (bars * 4 * 60) / beatsPerMinute;
  return {
    ...shotPath(facts, {
      index: `(floor(${time} / ${n(shotSeconds)}) % ${CUT.length})`,
      progress: `((${time} % ${n(shotSeconds)}) / ${n(shotSeconds)})`,
      time,
      blockers,
    }),
    shotSeconds,
  };
}

export interface ShotDrive {
  readonly index: string;
  readonly progress: string;
  readonly time: string;
  readonly blockers?: readonly Blocker[];
  /** Handheld amplitude (1 = a few centimetres at rest); the director's energy. */
  readonly shake?: string;
  /** 0..1, decaying after a kick: the camera jolts forward and the lens punches in. */
  readonly punch?: string;
}

/**
 * The same shots driven from OUTSIDE (T1370b's director): `index` is an expression naming
 * which CUT entry is live, `progress` an expression from 0 (the cut) to 1 (the end of the
 * move), `time` the clock the handheld drift reads. Returned without a shot length — the
 * music decides it.
 */
export function shotPath(facts: FurnaceSceneFacts, drive: ShotDrive): Omit<CameraPath, "shotSeconds"> {
  const { index, time } = drive;
  const blockers = drive.blockers ?? [];
  const local = `clamp(${drive.progress}, 0, 1)`;
  // Each easing centred on zero: −0.5 at the cut in, +0.5 at the end of the move.
  const eases = {
    smooth: `((${local}) ^ 2 * (3 - 2 * (${local})) - 0.5)`,
    whip: `(0.5 - (1 - ${local}) ^ 3)`,
    creep: `(${local} - 0.5)`,
  } as const;
  const shake = drive.shake ?? "1";
  const punch = drive.punch ?? "0";
  // Handheld: two incommensurate sines per axis, a few centimetres at rest, more when the
  // music pushes — the operator's hands getting less steady.
  // A per-frame JITTER of a centimetre, a pseudo-random function of the clock (so the previous
  // frame's camera is exactly reproducible): it moves every surface a fraction of a pixel frame
  // to frame, which is what gives the TAA history new samples to average.
  const jitter = (salt: number): string => `((fract(sin(${time} * ${7919.37 + salt}) * 43758.5453) - 0.5) * 0.012)`;
  const hand = [
    `((sin(${time} * 1.7) * 0.018 + sin(${time} * 4.1) * 0.006 + sin(${time} * 11.3) * 0.004) * ${shake} + ${jitter(0)})`,
    `((sin(${time} * 2.3 + 1.0) * 0.014 + sin(${time} * 5.3) * 0.005 + sin(${time} * 13.7) * 0.004) * ${shake} + ${jitter(13.1)})`,
    `((sin(${time} * 1.9 + 2.0) * 0.016 + sin(${time} * 9.1) * 0.004) * ${shake} + ${jitter(29.7)})`,
  ];
  const eyeTerms: [string[], string[], string[]] = [[], [], []];
  const aimTerms: [string[], string[], string[]] = [[], [], []];
  const fovTerms: string[] = [];
  const rollTerms: string[] = [];
  CUT.forEach((move, k) => {
    const shot = framing(facts, move);
    const { forward, right } = basis(shot.forward);
    const ease = eases[move.ease ?? "smooth"];
    const active = `(${index} == ${k})`;
    // Each half of a straight move is shortened to keep CLEARANCE from every surface.
    const full = [0, 1, 2].map(
      (axis) =>
        ((move.dolly ?? 0) + (move.vertigo ?? 0)) * forward[axis]! + (move.truck ?? 0) * right[axis]! + (move.crane ?? 0) * (axis === 1 ? 1 : 0),
    );
    const back = safeShare(blockers, shot.eye, full.map((value) => -value * 0.5));
    const ahead = safeShare(blockers, shot.eye, full.map((value) => value * 0.5));
    const signedEase = `(max(${ease}, 0) * ${n(ahead)} + min(${ease}, 0) * ${n(back)})`;
    const aimRest = [0, 1, 2].map((axis) => shot.eye[axis]! + forward[axis]! * shot.reach);
    const ride = move.follow === undefined ? "" : ` + op('kernel_rig').par.${move.follow}`;
    // The kick: a jolt along the view, 25 cm at full punch.
    const jolt = (axis: number): string => ` + ${n(forward[axis]! * 0.25)} * ${punch}`;
    for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
      const translate = full[axis]!;
      let eye: string;
      if (move.orbit !== undefined) {
        // Orbit about the aim point around world Y: rotate (eye − aim) by orbit·ease, plus
        // any straight move on top.
        const dx = shot.eye[0]! - aimRest[0]!;
        const dz = shot.eye[2]! - aimRest[2]!;
        const angle = `(${n(move.orbit)} * ${ease})`;
        const base =
          axis === 0
            ? `(${n(aimRest[0]!)} + ${n(dx)} * cos(${angle}) + ${n(dz)} * sin(${angle}))`
            : axis === 2
              ? `(${n(aimRest[2]!)} - ${n(dx)} * sin(${angle}) + ${n(dz)} * cos(${angle}))`
              : `${n(shot.eye[1]!)}`;
        eye = `(${base} + ${n(translate)} * ${signedEase})`;
      } else {
        eye = `(${n(shot.eye[axis]!)} + ${n(translate)} * ${signedEase})`;
      }
      eyeTerms[axis].push(`${active} * (${eye}${axis === 0 ? ride : ""}${jolt(axis)})`);
      // An orbit and a dolly zoom keep the subject; the other moves carry the aim with the eye.
      const aimMoves = move.orbit === undefined && move.vertigo === undefined;
      const aim = aimMoves ? `(${n(aimRest[axis]!)} + ${n(translate)} * ${signedEase})` : n(aimRest[axis]!);
      aimTerms[axis].push(`${active} * (${aim}${axis === 0 ? ride : ""})`);
    }
    // The lens: its own push, the dolly zoom's compensation (the subject at `reach` keeps its
    // size as the eye backs off), and the kick's punch.
    const vertigoFov =
      move.vertigo === undefined
        ? `${n(shot.fov)}`
        : // The expression engine has no tan/atan; at a telephoto lens the angle is its tangent.
          `(${n(shot.fov)} * ${n(shot.reach)} / (${n(shot.reach)} - ${n(move.vertigo)} * ${ease}))`;
    fovTerms.push(`${active} * (${vertigoFov} + ${n(move.push ?? 0)} * ${ease} - 4 * ${punch})`);
    if (move.roll !== undefined) rollTerms.push(`${active} * ${n(move.roll)} * ${ease}`);
  });
  return {
    eye: [0, 1, 2].map((axis) => `${eyeTerms[axis as 0 | 1 | 2].join(" + ")} + ${hand[axis]}`) as unknown as [string, string, string],
    aim: [0, 1, 2].map((axis) => aimTerms[axis as 0 | 1 | 2].join(" + ")) as unknown as [string, string, string],
    fov: fovTerms.join(" + "),
    roll: rollTerms.length === 0 ? "0" : rollTerms.join(" + "),
  };
}
