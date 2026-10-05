import { describe, expect, it } from "vitest";
import { flattenComponents } from "../../compiler/flatten.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { evaluateExpression } from "../../domain/expressions/evaluate.ts";
import { starterComponentsView } from "../../examples/component-files.ts";
import { SHOWCASE_BEAT, showcaseBarStart } from "../../examples/build-showcase-beat.ts";
import { shippedClipAudio } from "../../examples/shipped-clip-audio.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { against, pace, surge } from "./director.ts";
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

  it("swims only when the track is well over the quietest it has lately been", () => {
    expect(read(surge("follow", "lift"), { follow: 1, lift: 1.5 })).toBe(0);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 1.85 })).toBeCloseTo(0.5, 12);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 2.2 })).toBe(1);
    expect(read(surge("follow", "lift"), { follow: 0, lift: 2.2 })).toBe(0);
  });

  it("follows nothing in silence: a host with no track behaves as the panel says", () => {
    expect(read(pace("follow", "energy"), { follow: 1, energy: 0 })).toBe(1);
    expect(read(surge("follow", "lift"), { follow: 1, lift: 0 })).toBe(0);
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
  /** How much it swims, per frame: the channel every piece's kernel reads. */
  readonly swim: number[];
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
  const swim: number[] = [];
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
    rate.push(read("rate1:value"));
    energy.push(read("constant_energy:value"));
    swim.push(read("lag_swim:value"));
    last = read("travel1:value");
    if (index === 0) first = last;
  }
  return { rate, energy, swim, distance: last - first };
}

/** The frames of a stretch of the clip, in seconds. */
function during<T>(values: readonly T[], from: number, to: number): T[] {
  return values.slice(Math.round(from * FPS), Math.round(to * FPS));
}

describe("the sentinel follows its own clip, through the document's value graph", () => {
  it("walks at the pace the track's energy sets, frame for frame, and at half pace through the breakdown", async () => {
    const followed = await run(true, true);
    const panel = await run(false, true);
    // The energy is the track's and not the switch's: both runs hear the same.
    expect(followed.energy).toEqual(panel.energy);
    // Every frame: the pace is the panel's own times what the energy says. (The kick's shove
    // is in both, so it divides out.)
    const ratio = followed.rate.map((value, index) => value / panel.rate[index]!);
    const sounding = ratio.map((value, index) => ({ ratio: value, energy: followed.energy[index]! })).filter((frame) => frame.energy > 0);
    expect(sounding.length).toBeGreaterThan(FRAMES * 0.95);
    for (const frame of sounding) expect(frame.ratio).toBeCloseTo(Math.min(1.6, Math.max(0.5, 1 + (frame.energy - 1) * 1.5)), 9);
    // The breakdown: from a second and a half into the silent bars until the track is back,
    // it walks at half the panel's speed. With the switch off it never does.
    for (const value of during(ratio, SILENT.from + 1.5, SILENT.to)) expect(value).toBeCloseTo(0.5, 9);
    // So it ends somewhere else along the tunnel (measured on the clip: 141 m against 121 m).
    expect(Math.abs(followed.distance - panel.distance)).toBeGreaterThan(5);
  });

  it("holds the wall through the breakdown, swims when the track comes back in, and takes hold again", async () => {
    const followed = await run(true, true);
    const panel = await run(false, true);
    // Measured on the clip: at most 0.003 from three seconds before the silent bars until half
    // a second before the return; never under 0.98 from a second and a half to four seconds
    // after it; 0.05 to 0.10 ten seconds after it.
    expect(Math.max(...during(followed.swim, SILENT.from - 3, SILENT.to - 0.5))).toBeLessThan(0.01);
    expect(Math.min(...during(followed.swim, SILENT.to + 1.5, SILENT.to + 4))).toBeGreaterThan(0.95);
    expect(Math.max(...during(followed.swim, SILENT.to + 9.5, SILENT.to + 10))).toBeLessThan(0.15);
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
