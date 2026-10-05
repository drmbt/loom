import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../../domain/expressions/evaluate.ts";
import { CHAMBERS, PATH, chamberAt, chamberExpression, pathAt, pathExpression } from "./path.ts";
import { LAMP_SPACING, LAMP_TONES, lampTone, lampToneExpression } from "./tunnel.ts";

/**
 * T1561b — the tunnel's centreline has three readers (the joints and the tunnel on the GPU,
 * the camera on the CPU) and one definition. This file holds the CPU half to it; the GPU half
 * is read off a kernel's own buffer in rig.gpu.test.ts.
 */
describe("the tunnel path", () => {
  const SAMPLES = [0, 0.37, 12.5, 233.3, 479.9, 959.99];

  it("the camera's expression is the same line", () => {
    const expression = pathExpression("z");
    for (const z of SAMPLES) {
      const [x, y] = pathAt(z);
      const readX = evaluateExpression(expression.x, { z });
      const readY = evaluateExpression(expression.y, { z });
      if (!readX.ok || !readY.ok) throw new Error(`the path expression does not evaluate at z = ${z}`);
      // The expression carries its constants to nine significant digits: over 960 m that is
      // 2e-8 rad of phase on a 14 m amplitude, well under a micrometre.
      expect(Math.abs(readX.value - x)).toBeLessThan(1e-6);
      expect(Math.abs(readY.value - y)).toBeLessThan(1e-6);
    }
  });

  it("closes on itself after one period, so the travel distance can wrap unseen", () => {
    for (const z of SAMPLES) {
      const here = pathAt(z);
      const lap = pathAt(z + PATH.period);
      // Every term runs a whole number of cycles per period: the only difference is the sine's own rounding at the larger argument.
      expect(Math.abs(lap[0] - here[0])).toBeLessThan(1e-9);
      expect(Math.abs(lap[1] - here[1])).toBeLessThan(1e-9);
    }
  });

  it("the expression's chambers are the reference's, flare and all", () => {
    for (let z = 0; z < PATH.period; z += 0.37) {
      const read = evaluateExpression(chamberExpression("z"), { z });
      if (!read.ok) throw new Error(`the chamber expression does not evaluate at z = ${z}`);
      // The same arithmetic in the same 64 bits: only the order of two subtractions differs.
      expect(Math.abs(read.value - chamberAt(z))).toBeLessThan(1e-12);
    }
    // …and it does both: a hall's middle is 1 and the bore between halls is 0.
    expect([chamberAt(CHAMBERS.spacing / 2), chamberAt(0)]).toEqual([1, 0]);
  });

  it("a lamp's light is the colour of its plate at every station of the tunnel, wrap included", () => {
    const stations = Math.round(PATH.period / LAMP_SPACING);
    const seen = new Set<string>();
    // One station before the start and one past the end: the lamp behind the robot as the travel wraps must not change colour.
    for (let station = -1; station <= stations; station += 1) {
      const expected = lampTone(station);
      const read = lampToneExpression("n").map((source) => evaluateExpression(source, { n: station }));
      for (const [index, channel] of read.entries()) {
        if (!channel.ok) throw new Error(`the lamp tone expression does not evaluate at station ${station}`);
        expect([station, index, channel.value]).toEqual([station, index, expected[index]]);
      }
      seen.add(expected.join());
    }
    // All three tones occur, so the rule is not one colour that trivially agrees with itself.
    expect(seen.size).toBe(3);
    // The same lamp either side of the wrap.
    expect(lampTone(-1)).toEqual(lampTone(stations - 1));
    expect(LAMP_TONES.alarmEvery).toBeGreaterThan(1);
  });

  it("refuses to be a straight pipe: it wanders by metres, not millimetres", () => {
    // What the camera, the lights and every bend of the tunnel read. A path that flattened to the axis would pass the two checks above.
    const xs = Array.from({ length: 96 }, (_, index) => pathAt(index * 10)[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
  });
});
