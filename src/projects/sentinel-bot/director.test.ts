import { describe, expect, it } from "vitest";
import { flattenComponents } from "../../compiler/flatten.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { evaluateExpression } from "../../domain/expressions/evaluate.ts";
import { starterComponentsView } from "../../examples/component-files.ts";
import { SHOWCASE_BEAT, showcaseBarStart } from "../../examples/build-showcase-beat.ts";
import { shippedClipAudio } from "../../examples/shipped-clip-audio.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { PHRASE_BARS, against, pace, phraseDraw, phrasePerch, phraseSwim, rest, stride, surge } from "./director.ts";
import { sentinelDocument } from "./document.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";

/** T1561b — what following the track does to the pace and to swimming, read through the expression engine that runs it. */
function read(source: string, scope: Record<string, number>): number {
  const result = evaluateExpression(source, scope);
  if (!result.ok) throw new Error(`"${source}" does not evaluate`);
  return result.value;
}

describe("the sentinel follows the track", () => {
  it("measures a passage against a memory of the track, and no track at all is 0", () => {
    expect(read(against("loud", "memory"), { loud: 0.2, memory: 0.2 })).toBe(1);
    expect(read(against("loud", "memory"), { loud: 0.05, memory: 0.2 })).toBe(0.25);
    expect(read(against("loud", "memory"), { loud: 0.3, memory: 0.2 })).toBeCloseTo(1.5, 12);
    // Silence, and the first frame of a track over a memory of silence: no division by nothing.
    expect(read(against("loud", "memory"), { loud: 0, memory: 0 })).toBe(0);
    expect(read(against("loud", "memory"), { loud: 0.002, memory: 0 })).toBe(2);
  });

  it("is slower through a breakdown and faster through a loud passage, and the track is the difference", () => {
    expect(read(pace("follow", "energy"), { follow: 1, energy: 1 })).toBe(1);
    expect(read(pace("follow", "energy"), { follow: 1, energy: 0.8 })).toBeCloseTo(0.7, 12);
    expect(read(pace("follow", "energy"), { follow: 1, energy: 1.2 })).toBeCloseTo(1.3, 12);
    // Bounded both ways: a breakdown does not stop it and a drop does not fling it.
    expect(read(pace("follow", "energy"), { follow: 1, energy: 0.1 })).toBe(0.5);
    expect(read(pace("follow", "energy"), { follow: 1, energy: 4 })).toBe(1.6);
    // Cut the switch and every passage is walked at the panel's own speed.
    expect([0.1, 0.8, 1.2, 4].map((value) => read(pace("follow", "energy"), { follow: 0, energy: value }))).toEqual([1, 1, 1, 1]);
  });

  it("perches only when a breakdown has gone nearly silent", () => {
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0.3 })).toBe(0);
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0.21 })).toBeCloseTo(0.5, 12);
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0.12 })).toBe(1);
    expect(read(rest("follow", "energy"), { follow: 0, energy: 0.05 })).toBe(0);
  });

  it("swims only when the track is well over the quietest it has lately been", () => {
    expect(read(surge("follow", "lift"), { follow: 1, lift: 1.5 })).toBe(0);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 1.85 })).toBeCloseTo(0.5, 12);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 2.2 })).toBe(1);
    expect(read(surge("follow", "lift"), { follow: 0, lift: 2.2 })).toBe(0);
  });

  it("takes the long view a phrase at a time: swims some phrases when the passage is among the loudest of the last minute, perches some when among the quietest", () => {
    // A phrase is four bars, and its draw is the same wherever in the phrase it is asked, and another for the next.
    const draws = [0, 1, 3.9, 4, 7.99, 8].map((bar) => read(phraseDraw("bar", 1), { bar }));
    expect(PHRASE_BARS).toBe(4);
    expect([draws[1], draws[2]]).toEqual([draws[0], draws[0]]);
    expect(draws[4]).toBe(draws[3]);
    expect(new Set([draws[0], draws[3], draws[5]]).size).toBe(3);
    for (const draw of draws) expect(draw >= 0 && draw < 1).toBe(true);
    // Swimming: never under 0.7 of intensity whatever the draw; at the top, a draw under 0.66 swims and one over does not.
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 1, intensity: 0.7, draw: 0 })).toBe(0);
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 1, intensity: 1, draw: 0.6 })).toBe(1);
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 1, intensity: 1, draw: 0.7 })).toBe(0);
    expect(read(phraseSwim("follow", "intensity", "draw"), { follow: 0, intensity: 1, draw: 0 })).toBe(0);
    // Perching: only under 0.42, and then every other phrase.
    expect(read(phrasePerch("follow", "intensity", "draw"), { follow: 1, intensity: 0.3, draw: 0.4 })).toBe(1);
    expect(read(phrasePerch("follow", "intensity", "draw"), { follow: 1, intensity: 0.3, draw: 0.6 })).toBe(0);
    expect(read(phrasePerch("follow", "intensity", "draw"), { follow: 1, intensity: 0.5, draw: 0 })).toBe(0);
    // The pace: 0.65 at the quietest of the last minute, 1 in the middle, 1.35 at the loudest.
    expect([0, 0.5, 1].map((intensity) => read(stride("follow", "intensity"), { follow: 1, intensity }))).toEqual([0.65, 1, 1.35]);
    expect(read(stride("follow", "intensity"), { follow: 0, intensity: 1 })).toBe(1);
  });

  it("follows nothing in silence: a host with no track behaves as the panel says", () => {
    expect(read(pace("follow", "energy"), { follow: 1, energy: 0 })).toBe(1);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 0 })).toBe(0);
    // No track is not a silent breakdown: it does not sit down either.
    expect(read(rest("follow", "energy"), { follow: 1, energy: 0 })).toBe(0);
  });
});

/**
 * The same, through the document's own value graph hearing its own clip (the shipped beat,
 * by the app's offline walk), against the same frames with the Follow switch off. The clip's
 * arrangement is written down (`SHOWCASE_BEAT`): bars 9 and 10 are silent and bar 11 comes
 * back in full, so where the breakdown and the return fall is the clip's own statement.
 */
const FPS = 60;
const FRAMES = 30 * FPS;
const SILENT = { from: showcaseBarStart(SHOWCASE_BEAT.silence.from), to: showcaseBarStart(SHOWCASE_BEAT.silence.to + 1) };

interface Run {
  /** Metres a second asked of the robot, per frame. */
  readonly rate: number[];
  readonly energy: number[];
  readonly lift: number[];
  /** Where the passage stands among the last minute's, and the bar the track is in. */
  readonly intensity: number[];
  readonly bar: number[];
  /** How much it is told to swim, per frame, before the easing. */
  readonly swimAsked: number[];
  /** How much it swims, per frame: the channel every piece's kernel reads. */
  readonly swim: number[];
  /** How much it perches, per frame, before the easing the rig reads it through. */
  readonly perch: number[];
  /** Metres travelled by the last frame. */
  readonly distance: number;
}

async function run(follow: boolean, heard: boolean): Promise<Run> {
  const built = sentinelDocument(KIT_FIXTURE);
  const toggle = built.graph.nodes["toggle_follow"]!;
  const graph = { ...built.graph, nodes: { ...built.graph.nodes, toggle_follow: { ...toggle, parameters: { ...toggle.parameters, on: follow } } } };
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const flattened = flattenComponents({ graph, registry, components: await starterComponentsView() });
  const audio = shippedClipAudio(graph, FPS);
  if (audio === undefined) throw new Error("the sentinel binds the shipped beat; the test must hear it");
  const session = createValueGraphSession(registry);
  const rate: number[] = [];
  const energy: number[] = [];
  const lift: number[] = [];
  const intensity: number[] = [];
  const bar: number[] = [];
  const swimAsked: number[] = [];
  const swim: number[] = [];
  const perch: number[] = [];
  let first = Number.NaN;
  let last = Number.NaN;
  for (let index = 0; index < FRAMES; index += 1) {
    const features = heard ? audio(index) : null;
    const result = session.evaluate(
      flattened.graph,
      { timeSeconds: index / FPS, deltaSeconds: 1 / FPS, frameIndex: index, mode: "offline", randomSeed: 1 },
      { flattening: flattened, ...(features === null ? {} : { audio: features }) },
    );
    expect(result.diagnostics).toEqual([]);
    const read = (address: string): number => {
      const value = result.resolver(address, undefined as never);
      if (typeof value !== "number") throw new Error(`no channel ${address}`);
      return value;
    };
    rate.push(read("constant_rate:value"));
    energy.push(read("constant_energy:value"));
    lift.push(read("constant_lift:value"));
    intensity.push(read("lag_intensity:level"));
    bar.push(read("audiofile_track:bar"));
    swimAsked.push(read("constant_swim:value"));
    swim.push(read("lag_swim:value"));
    perch.push(read("constant_perch:value"));
    last = read("speed_travel:value");
    if (index === 0) first = last;
  }
  return { rate, energy, lift, intensity, bar, swimAsked, swim, perch, distance: last - first };
}

/** The frames of a stretch of the clip, in seconds. */
function during<T>(values: readonly T[], from: number, to: number): T[] {
  return values.slice(Math.round(from * FPS), Math.round(to * FPS));
}

/** The director's rules in plain arithmetic, for reading the chain's frames against. */
const smooth = (from: number, to: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
const drawOf = (bar: number, salt: number): number => {
  const x = Math.sin((Math.floor(bar / PHRASE_BARS) + salt) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

describe("the sentinel follows its own clip, through the document's value graph", () => {
  it("walks at the pace the track sets, frame for frame, and has stopped by the end of the breakdown", async () => {
    const followed = await run(true, true);
    const panel = await run(false, true);
    // What the track is doing is the track's and not the switch's: both runs hear the same.
    expect(followed.energy).toEqual(panel.energy);
    expect(followed.intensity).toEqual(panel.intensity);
    // Every frame: the pace is the panel's own, times what the energy says, times what the long view says, less what it perches.
    const ratio = followed.rate.map((value, index) => value / panel.rate[index]!);
    const sounding = ratio.map((value, index) => ({ ratio: value, energy: followed.energy[index]!, intensity: followed.intensity[index]!, perch: followed.perch[index]! })).filter((frame) => frame.energy > 0);
    expect(sounding.length).toBeGreaterThan(FRAMES * 0.95);
    for (const frame of sounding) expect(frame.ratio).toBeCloseTo(Math.min(1.6, Math.max(0.5, 1 + (frame.energy - 1) * 1.5)) * (1 + (frame.intensity - 0.5) * 0.7) * (1 - frame.perch), 9);
    // The breakdown, as measured on the clip: perched and standing still from three seconds into the silent
    // bars until the track is back.
    expect(during(followed.perch, SILENT.from + 3, SILENT.to).every((value) => value === 1)).toBe(true);
    expect(during(ratio, SILENT.from + 3, SILENT.to).every((value) => value === 0)).toBe(true);
    // With the switch off it never perches.
    expect(Math.max(...panel.perch)).toBe(0);
    // So it ends somewhere else along the tunnel.
    expect(Math.abs(followed.distance - panel.distance)).toBeGreaterThan(5);
  });

  it("swims and perches by its rules and nothing else, frame for frame; the return from the breakdown is a swim", async () => {
    const followed = await run(true, true);
    const panel = await run(false, true);
    let swimPhrases = 0;
    for (let index = 0; index < FRAMES; index += 1) {
      const sounding = followed.energy[index]! > 0;
      const margin = (followed.intensity[index]! - 0.7) * 2.2 - drawOf(followed.bar[index]!, 1);
      // A frame whose draw sits on the threshold could fall either way in the last bit of a double: not read.
      if (Math.abs(margin) < 1e-9) continue;
      const byPhrase = margin > 0 ? 1 : 0;
      swimPhrases += byPhrase;
      // Told to swim: the track coming back in (lift), or this phrase's turn at this intensity.
      expect(followed.swimAsked[index]).toBeCloseTo(Math.max(smooth(1.5, 2.2, followed.lift[index]!), byPhrase), 9);
      // Perched: a breakdown gone nearly silent, or this phrase's turn at a low intensity; never for no track.
      const low = followed.intensity[index]! < 0.42 && drawOf(followed.bar[index]!, 2) < 0.5 && sounding ? 1 : 0;
      const silent = sounding ? 1 - smooth(0.12, 0.3, followed.energy[index]!) : 0;
      expect(followed.perch[index]).toBeCloseTo(Math.max(silent, low), 9);
    }
    // In the last second of the silent bars it holds the wall; from two and a half seconds after the return it is swimming.
    // Measured on the clip: under 0.001 before, 0.95 and over after.
    expect(Math.max(...during(followed.swim, SILENT.to - 1, SILENT.to - 0.2))).toBeLessThan(0.02);
    expect(Math.min(...during(followed.swim, SILENT.to + 2.5, SILENT.to + 4))).toBeGreaterThan(0.9);
    // And the phrase rule did have its turn in these thirty seconds (88 frames of it on the clip), so the equality above read both branches.
    expect(swimPhrases).toBeGreaterThan(30);
    // The switch is the difference: off, the panel's Swim (0) is all there is.
    expect(Math.max(...panel.swim)).toBe(0);
  });

  it("with nothing playing the switch changes nothing", async () => {
    const followed = await run(true, false);
    const panel = await run(false, false);
    expect(followed.rate).toEqual(panel.rate);
    expect(followed.swim).toEqual(panel.swim);
    expect(Math.max(...followed.swim)).toBe(0);
    expect(followed.distance).toBe(panel.distance);
    expect(followed.distance).toBeGreaterThan(0);
  });
});
