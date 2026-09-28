import { describe, expect, it } from "vitest";
import type { ProjectDocument } from "../../domain/types/graph.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { LIMITS, edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { GRADE_WGSL } from "./fx.ts";
import { FINISH, withFinish } from "./finish.ts";

/**
 * T1407b (grade) — the finish is the film's last pass and the film's one grain. What matters:
 * the Output sees the finish, the finish sees what the Output saw before (nothing dropped
 * between), the shot grades' own grain is gone (or --final adds two grains and the measured
 * texture doubles), and a document is never finished twice (a plate finished, then finished
 * again by the shot that composites it, would get the lift and the toe twice).
 */
function shot(): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "p",
    name: "p",
    graph: graph(
      [
        node("shot", "solid", [0, 0], {}),
        node("grade", "customWgsl", [200, 0], { source: GRADE_WGSL, grain: 0.03 }),
        node("stock", "filmGrade", [400, 0], {}),
        node("out", "output", [600, 0], { toneMap: "none" }),
      ],
      [edge("a", ["shot", "out"], ["grade", "input"]), edge("b", ["grade", "out"], ["stock", "input"]), edge("c", ["stock", "out"], ["out", "input"])],
    ),
    settings: settings({ outputResolution: { width: 1920, height: 818 }, randomSeed: 7, limits: LIMITS }),
    assets: [],
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };
}

describe("withFinish", () => {
  it("puts the finish between the last pass and the Output, fed by what the Output saw", () => {
    const { graph: g } = withFinish(shot());
    const into = (nodeId: string, portId: string) => Object.values(g.edges).filter((e) => e.target.nodeId === nodeId && e.target.portId === portId);
    expect(into("out", "input").map((e) => e.source.nodeId)).toEqual(["look"]);
    expect(into("look", "input").map((e) => e.source.nodeId)).toEqual(["stock"]);
    expect(into("lookDown", "input").map((e) => e.source.nodeId)).toEqual(["stock"]);
    // the near glow first, then the wide one: the shader reads them as inputTexture1, inputTexture2
    expect(into("look", "more").sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((e) => e.source.nodeId)).toEqual(["lookNear", "lookWide"]);
  });

  it("owns the grain: every other grain goes to 0, the finish carries the measured one", () => {
    const { graph: g } = withFinish(shot());
    expect(g.nodes["grade"]!.parameters["grain"]).toBe(0);
    expect(g.nodes["stock"]!.parameters["grain"]).toBe(0);
    expect(g.nodes["look"]!.parameters["grain"]).toBe(FINISH.grain);
    expect(FINISH.grain).toBeGreaterThan(0);
  });

  it("refuses to finish a document twice", () => {
    expect(() => withFinish(withFinish(shot()))).toThrow(/finished already/);
  });
});
