import { beforeAll, describe, expect, it } from "vitest";
import { evaluateExpression } from "../../domain/expressions/evaluate.ts";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { CHAMBERS, PATH, chamberAt, pathAt } from "./path.ts";
import { CHASE, LAMP_ATTRIBUTES, LAMP_COUNT, LAMP_GAINS, LAMP_KERNEL, LAMP_SPACING, lampChase, lampHeightExpression, lampTone } from "./tunnel.ts";

/**
 * T1561b — THE CROWN LAMPS AS LIGHTS, read off the points a Light in Points mode stands its
 * lights on (the Light's own lighting is the engine's to prove, §T1589b).
 *
 * What the points owe the picture: a light hangs where its plate is drawn, in its plate's
 * colour and at its plate's strength (a dead lamp lights nothing), there is one for every
 * station of the lap wherever along the lap the robot is, and a station that has a Light of
 * its own is not lit twice.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const BORE = 2.6;
const LAMP = 26;

interface Lamps {
  position(index: number): [number, number, number];
  tint(index: number): [number, number, number];
  power(index: number): number;
}

async function lamps(travel: number, named = 0, chase: { at: number; depth: number } = { at: 0, depth: 0 }): Promise<Lamps> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const points = node("kernel_lamps", "pointKernel", [0, 0], { capacity: LAMP_COUNT, attributes: LAMP_ATTRIBUTES, kernel: LAMP_KERNEL, travel, bore: BORE, lamp: LAMP, named, chaseAt: chase.at, chase: chase.depth });
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        points,
        node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
        node("geometry_lamps", "geometry", [0, 0], { mode: "points", material: "material_dot" }, { label: "geometry_lamps" }),
        node("camera_any", "camera", [0, 0], {}, { label: "camera_any" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_lamps", camera: "camera_any", lights: "" }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [edge("lamps-geo", ["kernel_lamps", "out"], ["geometry_lamps", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: 32, height: 32 } }),
    frames: 1,
    outputNodeId: "output_frame",
    probeBuffers: [pointStorageId("kernel_lamps")],
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const packed = (result.buffers ?? {})[pointStorageId("kernel_lamps")];
  if (packed === undefined) throw new Error("probe buffers missing");
  const position = kernelRegionSlice(points as never, packed, "position").floats;
  const tint = kernelRegionSlice(points as never, packed, "tint").floats;
  const power = kernelRegionSlice(points as never, packed, "power").floats;
  const [at, colour] = [position.length / LAMP_COUNT, tint.length / LAMP_COUNT];
  return {
    position: (index) => [position[index * at] as number, position[index * at + 1] as number, position[index * at + 2] as number],
    tint: (index) => [tint[index * colour] as number, tint[index * colour + 1] as number, tint[index * colour + 2] as number],
    power: (index) => power[index] as number,
  };
}

/** The station a point of the window stands for, with the robot `travel` metres along (tunnel.ts, LAMP_KERNEL). */
const stationOf = (index: number, travel: number): number => Math.floor(travel / LAMP_SPACING) + index - Math.floor(LAMP_COUNT / 2);

describe("the crown lamps as lights (T1561b)", () => {
  it("stands one light under every plate of the lap, in the plate's colour and at its strength, wherever along the lap the robot is", async () => {
    expect(LAMP_COUNT * LAMP_SPACING).toBe(PATH.period);
    // Mid-lap; in a hall; and with the robot a few metres short of the lap's end, half its lamps past it.
    for (const travel of [300, CHAMBERS.spacing / 2, PATH.period - 5]) {
      const lit = await lamps(travel);
      const seen = new Set<number>();
      let dead = 0;
      let halls = 0;
      for (let index = 0; index < LAMP_COUNT; index += 1) {
        const station = stationOf(index, travel);
        const z = (station + 0.5) * LAMP_SPACING;
        seen.add(((station % LAMP_COUNT) + LAMP_COUNT) % LAMP_COUNT);
        const at = lit.position(index);
        // Where the plate is: on the line, under the wall's own crown (the height the plate's picture in the steel
        // and the lit air are placed by: one expression, lampHeightExpression).
        const height = evaluateExpression(lampHeightExpression("z", "bore"), { z, bore: BORE });
        if (!height.ok) throw new Error("the lamp's height does not evaluate");
        const line = pathAt(z);
        expect(Math.abs(at[0] - line[0])).toBeLessThan(2e-3);
        expect(Math.abs(at[1] - height.value)).toBeLessThan(2e-3);
        expect(Math.abs(at[2] - z)).toBeLessThan(2e-3);
        // Its plate's colour, as a light reads a colour (linear), and a hall's lamp the bigger by how much higher it hangs.
        const tone = lampTone(station);
        for (const [channel, value] of lit.tint(index).entries()) expect(Math.abs(value - (tone[channel] as number) ** 2.2)).toBeLessThan(2e-4);
        const high = 1 + CHAMBERS.swell * chamberAt(z);
        expect(Math.abs(lit.power(index) - LAMP * high)).toBeLessThan(1e-3);
        if (Math.max(...tone) <= 0.06) dead += 1;
        if (high > 1.5) halls += 1;
      }
      // Every station of the lap exactly once, whichever side of the lap's end it is on.
      expect(seen.size).toBe(LAMP_COUNT);
      // The rule's dead lamps and its hall lamps were both among them.
      expect(dead).toBeGreaterThan(5);
      expect(halls).toBeGreaterThan(5);
    }
    expect(LAMP_GAINS.filter((gain) => gain <= 0.06).length).toBeGreaterThan(0);
  }, 240_000);

  it("the chase: one lamp in four is up and which one glides down the tunnel a station a beat; the lamps' sum is what it was; at no depth nothing moves", async () => {
    // The owner, 2026-10-06: the tunnel's lights "audio reactive to certain other features of the song, maybe the
    // hats, without getting too flickery".
    const travel = 300;
    const first = Math.floor(travel / LAMP_SPACING) - Math.floor(LAMP_COUNT / 2);
    const still = await lamps(travel);
    const DEPTH = 0.6;
    for (const at of [40, 40.25, 40.5, 41, 43.7]) {
      const run = await lamps(travel, 0, { at, depth: DEPTH });
      for (let index = 0; index < LAMP_COUNT; index += 1) {
        // Each lamp: its own strength times the rule's, to a float.
        expect(run.power(index)).toBeCloseTo(still.power(index) * lampChase(first + index, at, DEPTH), 3);
        // Its colour and its place are its own, chase or no chase.
        expect(run.tint(index)).toEqual(still.tint(index));
        expect(run.position(index)).toEqual(still.position(index));
      }
    }
    // The rule itself. On a beat the lamp at that station is at its most and the two either side of it at their least…
    expect([lampChase(40, 40, DEPTH), lampChase(39, 40, DEPTH), lampChase(41, 40, DEPTH), lampChase(42, 40, DEPTH)].map((value) => Math.round(value * 1000) / 1000)).toEqual([1 + DEPTH * (CHASE.up - CHASE.down), 1 - DEPTH * CHASE.down, 1 - DEPTH * CHASE.down, 1 - DEPTH * CHASE.down].map((value) => Math.round(value * 1000) / 1000));
    // …a beat later it is the next lamp down the tunnel, and every fourth lamp is as it is.
    expect(lampChase(41, 41, DEPTH)).toBe(lampChase(40, 40, DEPTH));
    expect(lampChase(44, 40, DEPTH)).toBeCloseTo(lampChase(40, 40, DEPTH), 12);
    // It glides: half way through the beat the two lamps it is between are level, and neither is at the most.
    expect(lampChase(40, 40.5, DEPTH)).toBeCloseTo(lampChase(41, 40.5, DEPTH), 12);
    expect(lampChase(40, 40.5, DEPTH)).toBeLessThan(lampChase(40, 40, DEPTH));
    // Never a blink: through a whole beat in sixty steps no lamp's strength moves by a twentieth of itself at a step.
    for (let station = 38; station < 44; station += 1) {
      for (let step = 0; step < 60; step += 1) expect(Math.abs(lampChase(station, 40 + (step + 1) / 60, DEPTH) - lampChase(station, 40 + step / 60, DEPTH))).toBeLessThan(0.05);
    }
    // The tunnel is no brighter for it: any four lamps in a row sum to four, wherever the chase is.
    for (const at of [40, 40.3, 41.77]) expect(lampChase(10, at, DEPTH) + lampChase(11, at, DEPTH) + lampChase(12, at, DEPTH) + lampChase(13, at, DEPTH)).toBeCloseTo(4, 9);
    // No depth: every lamp is itself, wherever the chase is.
    expect(lampChase(40, 40, 0)).toBe(1);
  }, 240_000);

  it("does not light a lamp twice: the three stations that have Lights of their own are dimmed by as much as those are lit", async () => {
    const travel = 300;
    const [alone, beside] = [await lamps(travel, 0), await lamps(travel, 1)];
    let dimmed = 0;
    for (let index = 0; index < LAMP_COUNT; index += 1) {
      const z = (stationOf(index, travel) + 0.5) * LAMP_SPACING;
      // What its own Light has of it (document.ts, lampAt): all of it within half a spacing, none a spacing and a half off.
      const near = Math.min(1, Math.max(0, 1.5 - Math.abs(z - travel) / LAMP_SPACING));
      expect(Math.abs(beside.power(index) + near * alone.power(index) - alone.power(index))).toBeLessThan(1e-3);
      if (near > 0) dimmed += 1;
    }
    expect(dimmed).toBe(3);
  }, 240_000);
});
