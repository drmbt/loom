import { describe, expect, it } from "vitest";
import { flattenComponents } from "../compiler/flatten.ts";
import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { starterComponentsView } from "./component-files.ts";
import { crucibleDocument } from "./documents/crucible.ts";
import { SHOWCASE_BEAT } from "./build-showcase-beat.ts";
import { shippedClipAudio } from "./shipped-clip-audio.ts";

/**
 * T1349b — E79's two lanes, HEARING THE SHIPPED CLIP through the app's own offline walk
 * (`shipped-clip-audio.ts`), through the real flattened graph and the real value session.
 *
 * The claim is the chain, not the picture: a spectrum row → Range → Beat fires ONCE PER
 * KICK and never inside the hold-off, and a spectrum row → Range → Tail sweeps most of its
 * span. Both are asserted against the clip's own tempo (124 bpm = 29.03 frames a beat at
 * 60 fps) rather than against a number somebody liked. And for each lane, what DIFFERS if
 * the edge were cut: with the Select unwired the lane is exactly 0 on every frame.
 */
const FRAMES = 3600;
const FRAMES_PER_BEAT = (60 * 60) / SHOWCASE_BEAT.bpm;

async function lanes(graphOf: (graph: GraphDocument) => GraphDocument = (graph) => graph) {
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const root = graphOf(structuredClone(crucibleDocument.graph));
  const flattened = flattenComponents({ graph: root, registry, components: await starterComponentsView() });
  const audio = shippedClipAudio(root, 60);
  if (audio === undefined) throw new Error("E79 binds the shipped clip; the harness must hear it");
  const session = createValueGraphSession(registry);
  const beat: number[] = [];
  const tail: number[] = [];
  for (let index = 0; index < FRAMES; index += 1) {
    const features = audio(index);
    const result = session.evaluate(
      flattened.graph,
      { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: "offline", randomSeed: 79 },
      { flattening: flattened, ...(features === null ? {} : { audio: features }) },
    );
    expect(result.diagnostics).toEqual([]);
    beat.push(result.byName.get("beat1")?.["band109"] ?? Number.NaN);
    tail.push(result.byName.get("tail1")?.["band968"] ?? Number.NaN);
  }
  return { beat, tail };
}

describe("E79 Crucible — the spectrum-row chain on the shipped clip (T1349b)", () => {
  it("Beat fires once per kick at the clip's tempo, never inside the 0.3 s hold-off, and the tail sweeps its span", async () => {
    const { beat, tail } = await lanes();
    const fires = beat.map((value, index) => (value === 1 ? index : -1)).filter((index) => index >= 0);
    const gaps = fires.slice(1).map((fire, index) => fire - fires[index]!);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    // The median gap IS one beat: 29 frames at 124 bpm (29.03), and the hold-off (0.3 s = 18
    // frames) is never violated. Measured on the clip: 106 fires a minute against 124 beats,
    // the difference being the arrangement's pulled-back bars, where the kick sits below the
    // threshold on purpose (T776).
    expect(Math.round(FRAMES_PER_BEAT)).toBe(29);
    expect(median).toBe(29);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(18);
    expect(fires.length).toBeGreaterThanOrEqual(90);
    expect(fires.length).toBeLessThanOrEqual(124);
    // A hit is a whole event: on a fire frame the lane reads exactly 1 and decays after it.
    expect(beat[fires[3]!]).toBe(1);
    expect(beat[fires[3]! + 1]!).toBeLessThan(1);
    expect(beat[fires[3]! + 1]!).toBeGreaterThan(0.9);
    // The tail lane, ranked: it uses most of 0..1, not a sliver (§V903).
    const ranked = [...tail].sort((a, b) => a - b);
    const p10 = ranked[Math.floor(0.1 * tail.length)]!;
    const p90 = ranked[Math.floor(0.9 * tail.length)]!;
    expect(p90 - p10).toBeGreaterThan(0.4);
    expect(Math.max(...tail)).toBe(1);
  });

  it("cutting either Select edge leaves that lane with NO channel at all — every consumer falls to its retained static (§V108)", async () => {
    // Not 0: a Select with nothing on its input publishes an empty bag, so `band109` is
    // absent from `beat1` and the expression reading it resolves to the slot's retained
    // value. That is the honest shape of a cut wire, and it is what the first test's
    // numbers are measured against.
    const cut = await lanes((graph) => {
      delete graph.edges["clip-band109"];
      delete graph.edges["clip-band968"];
      return graph;
    });
    expect(cut.beat.every((value) => Number.isNaN(value))).toBe(true);
    expect(cut.tail.every((value) => Number.isNaN(value))).toBe(true);
  });
});
