import type { GraphEdge, GraphNode } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SPECTRUM_BAND_NAMES } from "../../domain/audio/spectrum-bands.ts";
import { edge, node as buildNode } from "../../examples/documents/builders.ts";
import { CLOSE_POOL, CUT, DISCOVERED, HOT_POOL } from "./camera-path.ts";

/**
 * T1370b — THE DIRECTOR: the music chooses, inside boundaries the document states.
 *
 * Built from the structure nodes (Trend, Rate, Novelty, Count, Delay) over the source's
 * record, it publishes the few numbers the scene is driven by:
 *
 *   normalize_dirEnergy    loudness, ranked over 45 s — where this moment sits in the arrangement;
 *   normalize_dirBright    spectral centroid, ranked over 30 s — dark breaks vs bright walls of noise
 *                          (this track's sections live here more than in loudness, measured);
 *   normalize_dirDensity   onsets per second, ranked over 30 s — how busy;
 *   range_dirBuild         the 6 s trend of energy, positive part, scaled — a build-up;
 *   count_dirSections      a count of spectral novelty spikes (12 s apart at least) — section changes;
 *   count_dirCuts          a count of CUTS and seconds since the last — the shot clock;
 *   expression_dirShot     which framing is live.
 *
 * THE BOUNDARIES (the part a person authors): cuts land only on bar lines; a shot lasts 8
 * bars when calm, 4 when energetic, 2 when energetic AND dense; a section change cuts at
 * once; energetic moments draw from the close, dynamic framings and calm ones from the
 * wide, slow ones; the pick within a pool is a hash of the cut and section counts, so it
 * never repeats predictably and always reproduces. Nothing is keyed to a timestamp.
 *
 * Deterministic from the transport start (every node here replays from a reset), which is
 * what makes an offline take of the whole track the performance the app would give.
 */

/**
 * What each of the director's nodes is called: its kind, then the lane it is (T1593b). A
 * node's id is the lane; its name is written out here, so the name a person reads on the
 * canvas can be found in this file, and `chan` reads a node by the name it was given. Where
 * the lane's own word was the kind (`dirRate` on a Rate) the kind is not said twice.
 */
const NAMES = {
  dirPick: "select_dirPick",
  dirGrid: "select_dirGrid",
  dirBands: "select_dirBands",
  dirLevel: "select_dirLevel",
  dirLevelLag: "lag_dirLevel",
  dirEnergy: "normalize_dirEnergy",
  dirAbsolute: "expression_dirAbsolute",
  dirIntensity: "expression_dirIntensity",
  dirCentroid: "select_dirCentroid",
  dirCentroidLag: "lag_dirCentroid",
  dirBright: "normalize_dirBright",
  dirOnsets: "select_dirOnsets",
  dirRate: "rate_dir",
  dirDensity: "normalize_dirDensity",
  dirTrend: "trend_dir",
  dirBuild: "range_dirBuild",
  dirNovelty: "novelty_dir",
  dirNoveltyRank: "normalize_dirNoveltyRank",
  dirSections: "count_dirSections",
  dirBeatPick: "select_dirBeatPick",
  dirBeats: "count_dirBeats",
  dirKickPick: "select_dirKickPick",
  dirKicks: "count_dirKicks",
  dirOnsetCounts: "count_dirOnsetCounts",
  dirGate: "expression_dirGate",
  dirClocks: "expression_dirClocks",
  dirCuts: "count_dirCuts",
  dirCutPick: "select_dirCutPick",
  dirShot: "expression_dirShot",
  dirPreviousCut: "delay_dirPreviousCut",
  dirPreviousShot: "delay_dirPreviousShot",
} as const;

type Lane = keyof typeof NAMES;

function node(id: Lane, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>): GraphNode {
  return buildNode(id, type, position, {}, { label: NAMES[id], parameters });
}

const chan = (name: Lane, channel = "value"): string => `op('${NAMES[name]}').chan.${channel}`;

export interface Director {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Expressions the scene reads. */
  readonly energy: string;
  readonly bright: string;
  readonly density: string;
  readonly build: string;
  /** The live framing (CUT index) and seconds since the cut, this frame and one frame ago. */
  readonly shot: string;
  readonly since: string;
  readonly previousShot: string;
  readonly previousSince: string;
}

export function director(source: string, origin: readonly [number, number]): Director {
  const [x, y] = origin;
  const at = (column: number, row: number): readonly [number, number] => [x + column * 300, y + row * 200];
  // The lanes keep their source's channel names through select → lag → rank.
  const energy = chan("dirIntensity", "level");
  const density = chan("dirDensity", "onsetCount");
  const nodes: GraphNode[] = [
    node("dirPick", "valueSelect", at(0, 0), { channels: "level centroid onsetCount beatCount" }),
    // The tempo grid alone, so its channels shadow nothing in the gate.
    node("dirGrid", "valueSelect", at(4, 3), { channels: "beat beatPhase" }),
    node("dirBands", "valueSelect", at(0, 3), { channels: SPECTRUM_BAND_NAMES.join(" ") }),
    // Energy and brightness: follow, then rank over the arrangement.
    node("dirLevel", "valueSelect", at(1, 0), { channels: "level" }),
    node("dirLevelLag", "valueLag", at(2, 0), { lag: 0.25, releaseRatio: 2 }),
    node("dirEnergy", "valueNormalize", at(3, 0), { window: 45 }),
    // A rank only knows the history it has: in a song's opening bars a quiet intro ranks
    // against itself and reads as LOUD. The absolute level (mastered loudness, comparable
    // across tracks) caps it — an intro can only be as intense as it is loud.
    node("dirAbsolute", "valueExpression", at(3, -1), { expressions: "absolute = level" }),
    node("dirIntensity", "valueExpression", at(3.5, 0), { expressions: "level = min(level, clamp((absolute - 0.09) / 0.16, 0, 1))" }),
    node("dirCentroid", "valueSelect", at(1, 1), { channels: "centroid" }),
    node("dirCentroidLag", "valueLag", at(2, 1), { lag: 0.4, releaseRatio: 1 }),
    node("dirBright", "valueNormalize", at(3, 1), { window: 30 }),
    // Density: onsets per second, ranked.
    node("dirOnsets", "valueSelect", at(1, 2), { channels: "onsetCount" }),
    node("dirRate", "valueRate", at(2, 2), { window: 3 }),
    node("dirDensity", "valueNormalize", at(3, 2), { window: 30 }),
    // Build-up: energy's 6 s trend, positive part.
    node("dirTrend", "valueTrend", at(4, 0), { window: 6 }),
    node("dirBuild", "valueRange", at(5, 0), { fromLow: 0, fromHigh: 0.35, toLow: 0, toHigh: 1, outside: "clamp" }),
    // Sections: spectral novelty over the bands, counted 12 s apart at least.
    node("dirNovelty", "valueNovelty", at(1, 3), { recent: 2, reference: 8 }),
    // RELATIVE, so any song works: novelty ranked against the last minute, a section is a
    // top-6% spike (an absolute threshold was this track's measured p90 — a second song would
    // have had none, or dozens).
    node("dirNoveltyRank", "valueNormalize", at(1.5, 3), { window: 60 }),
    node("dirSections", "valueCount", at(2, 3), { threshold: 0.94, holdoff: 12 }),
    // A running beat counter (the record's beatCount is 1 on a beat's frame, not a total).
    node("dirBeatPick", "valueSelect", at(4, 1), { channels: "beatCount" }),
    node("dirBeats", "valueCount", at(5, 1), { threshold: 0.5, holdoff: 0.2 }),
    // The kick itself — the cut lands ON it, not on the tracker's beat, which drifts from it.
    node("dirKickPick", "valueSelect", at(4, 2), { channels: "kickCount" }),
    node("dirKicks", "valueCount", at(5, 2), { threshold: 0.5, holdoff: 0.1 }),
    node("dirOnsetCounts", "valueCount", at(5, 2.5), { threshold: 0.5, holdoff: 0.1 }),
    // The cut gate, as an Expression over WIRED channels (a value node's own parameters do
    // not see channels). A shot runs a number of bars the music asks for — 4 calm, 2 loud, 1
    // loud AND dense — and the cut fires on the first KICK in the beat that closes it (the
    // tracker's bar clock only says WHICH beat; a kick a hair before the counted beat still
    // counts); in a breakdown with no kicks, on the counted beat. A section change cuts on the
    // first kick after it.
    node("dirGate", "valueExpression", at(6, 1), {
      // A song with no claimable tempo has no grid; a counter before its first event has no clock.
      defaults: "beat = -1; beatPhase = 0.5; kickCount = 0; kickCountSince = 99; beatCountSince = 99; novelty = 0; noveltySince = 99; onsetTotal = 0; onsetSince = 99; beatCount = 0",
      expressions: [
        "bars = 2 - (level > 0.7) - 0.5 * (level > 0.7) * (onsetCount > 0.8)",
        "span = 4 * bars",
        // The tempo grid is the bar clock: it keeps time through breakdowns, where kicks stop.
        "onBar = (beat % span == 0) * (beatPhase < 0.3) + (beat % span == span - 1) * (beatPhase > 0.8)",
        "kick = kickCountSince < 0.02",
        // No kick by a third of the way into the beat: cut on the grid anyway (the Count's
        // holdoff drops this if the kick already cut).
        "late = (beat % span == 0) * (beatPhase >= 0.3) * (beatPhase < 0.36)",
        // A song the tracker cannot claim a tempo for has no grid (beat stays at its default −1):
        // cut on every eighth kick, or every sixteenth onset where there are no kicks.
        "gridless = beat < 0",
        "fallback = gridless * (kick * (kickCount % 8 == 0) + (kickCountSince > 4) * (onsetSince < 0.02) * (onsetTotal % 16 == 0))",
        "cut = (1 - gridless) * (kick * onBar + late) + kick * (noveltySince < 1.5) * (novelty > 0) + fallback",
      ].join("; "),
    }),
    // The shot clock one frame back, under its own name so it shadows nothing in the gate.
    // The onset counter's clock under its own name (the raw onsetCount would bury the RANKED
    // density of the same name in the gate). NO feedback from the cuts: a value graph drops a
    // cycle whole, Delay or not — a gate reading its own shot clock silenced the director.
    node("dirClocks", "valueExpression", at(6.5, 2), { expressions: "onsetTotal = onsetCount; onsetSince = onsetCountSince", defaults: "onsetCount = 0; onsetCountSince = 99" }),
    node("dirCuts", "valueCount", at(7, 1), { threshold: 0.5, holdoff: 1.5 }),
    node("dirCutPick", "valueSelect", at(6.5, 0.5), { channels: "cut" }),
    // Which framing: energetic → the close pool, calm → the wide pool, the pick a hash of the
    // cut and section counts so it never repeats predictably and always reproduces.
    node("dirShot", "valueExpression", at(8, 1), {
      // The pick reads ONLY what changes at a cut (the cut and section counts): reading live
      // energy flipped the pool mid-shot whenever energy crossed its threshold, and the camera
      // jumped between two framings with no cut. Every other cut is HOT; the rest alternate
      // close and wide, the section count shifting the phase so sections differ.
      expressions: [
        // CUT: the hall search's drone framings first, then hot, close and wide.
        `disc = (floor(cut / 2) * 3 + novelty) % ${DISCOVERED}`,
        `hot = ${DISCOVERED} + (floor(cut / 5) + novelty) % ${HOT_POOL}`,
        `close = ${DISCOVERED + HOT_POOL} + (floor(cut / 5) * 3 + novelty) % ${CLOSE_POOL - HOT_POOL}`,
        `wide = ${DISCOVERED + CLOSE_POOL} + (floor(cut / 5) * 3 + novelty) % ${CUT.length - DISCOVERED - CLOSE_POOL}`,
        `phase = (cut + novelty) % 5`,
        `shot = (phase == 0) * hot + ((phase == 1) + (phase == 3)) * disc + (phase == 2) * close + (phase == 4) * wide`,
      ].join("; "),
    }),
    // One frame back, for the motion blur's previous camera.
    node("dirPreviousCut", "valueDelay", at(7, 2), { frames: 1 }),
    node("dirPreviousShot", "valueDelay", at(7, 3), { frames: 1 }),
  ];
  const edges: GraphEdge[] = [
    edge("dir-src-pick", [source, "out"], ["dirPick", "in"]),
    edge("dir-src-bands", [source, "out"], ["dirBands", "in"]),
    edge("dir-pick-level", ["dirPick", "out"], ["dirLevel", "in"]),
    edge("dir-level-lag", ["dirLevel", "out"], ["dirLevelLag", "in"]),
    edge("dir-lag-energy", ["dirLevelLag", "out"], ["dirEnergy", "in"]),
    edge("dir-lag-absolute", ["dirLevelLag", "out"], ["dirAbsolute", "in"]),
    edge("dir-energy-intensity", ["dirEnergy", "out"], ["dirIntensity", "in"], 0),
    edge("dir-absolute-intensity", ["dirAbsolute", "out"], ["dirIntensity", "in"], 1),
    edge("dir-pick-centroid", ["dirPick", "out"], ["dirCentroid", "in"]),
    edge("dir-centroid-lag", ["dirCentroid", "out"], ["dirCentroidLag", "in"]),
    edge("dir-lag-bright", ["dirCentroidLag", "out"], ["dirBright", "in"]),
    edge("dir-pick-onsets", ["dirPick", "out"], ["dirOnsets", "in"]),
    edge("dir-onsets-rate", ["dirOnsets", "out"], ["dirRate", "in"]),
    edge("dir-rate-density", ["dirRate", "out"], ["dirDensity", "in"]),
    edge("dir-energy-trend", ["dirIntensity", "out"], ["dirTrend", "in"]),
    edge("dir-trend-build", ["dirTrend", "out"], ["dirBuild", "in"]),
    edge("dir-bands-novelty", ["dirBands", "out"], ["dirNovelty", "in"]),
    edge("dir-novelty-rank", ["dirNovelty", "out"], ["dirNoveltyRank", "in"]),
    edge("dir-rank-sections", ["dirNoveltyRank", "out"], ["dirSections", "in"]),
    edge("dir-pick-beats", ["dirPick", "out"], ["dirBeatPick", "in"]),
    edge("dir-beatpick-beats", ["dirBeatPick", "out"], ["dirBeats", "in"]),
    edge("dir-beats-gate", ["dirBeats", "out"], ["dirGate", "in"], 0),
    edge("dir-energy-gate", ["dirIntensity", "out"], ["dirGate", "in"], 1),
    edge("dir-density-gate", ["dirDensity", "out"], ["dirGate", "in"], 2),
    edge("dir-sections-gate", ["dirSections", "out"], ["dirGate", "in"], 3),
    edge("dir-src-kicks", [source, "out"], ["dirKickPick", "in"]),
    edge("dir-kickpick-kicks", ["dirKickPick", "out"], ["dirKicks", "in"]),
    edge("dir-onsets-counts", ["dirOnsets", "out"], ["dirOnsetCounts", "in"]),
    edge("dir-kicks-gate", ["dirKicks", "out"], ["dirGate", "in"], 4),
    edge("dir-src-grid", [source, "out"], ["dirGrid", "in"]),
    edge("dir-grid-gate", ["dirGrid", "out"], ["dirGate", "in"], 5),
    edge("dir-onsets-clocks", ["dirOnsetCounts", "out"], ["dirClocks", "in"]),
    edge("dir-clocks-gate", ["dirClocks", "out"], ["dirGate", "in"], 6),
    edge("dir-gate-pick", ["dirGate", "out"], ["dirCutPick", "in"]),
    edge("dir-pick-cuts", ["dirCutPick", "out"], ["dirCuts", "in"]),
    edge("dir-cuts-shot", ["dirCuts", "out"], ["dirShot", "in"], 0),
    edge("dir-sections-shot", ["dirSections", "out"], ["dirShot", "in"], 1),
    edge("dir-cuts-previous", ["dirCuts", "out"], ["dirPreviousCut", "in"]),
    edge("dir-shot-previous", ["dirShot", "out"], ["dirPreviousShot", "in"]),
  ];
  return {
    nodes,
    edges,
    energy,
    bright: chan("dirBright", "centroid"),
    density,
    build: chan("dirBuild", "level"),
    shot: chan("dirShot", "shot"),
    since: chan("dirCuts", "cutSince"),
    previousShot: chan("dirPreviousShot", "shot"),
    previousSince: chan("dirPreviousCut", "cutSince"),
  };
}
