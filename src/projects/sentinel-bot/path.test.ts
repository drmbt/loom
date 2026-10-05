import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../../domain/expressions/evaluate.ts";
import { PATH, pathAt, pathExpression } from "./path.ts";

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

  it("refuses to be a straight pipe: it wanders by metres, not millimetres", () => {
    // What the camera, the lights and every bend of the tunnel read. A path that flattened to the axis would pass the two checks above.
    const xs = Array.from({ length: 96 }, (_, index) => pathAt(index * 10)[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
  });
});
