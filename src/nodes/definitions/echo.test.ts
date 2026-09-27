import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";
import { passStructureKey } from "../../runtime/backend/plan.ts";
import type { PassDescriptor } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { ECHO_DEFAULT_FRAMES, ECHO_RING_KEY, echoNode } from "./echo.ts";
import { compileContext, inputResourceId, outputResourceId } from "./test-support.ts";

/**
 * Echo on the plan (T1402b). Pixels — the trail's analytic values, the delay's spacing —
 * are `echo.gpu.test.ts`. Here: the node owns its history (a ring it archives its own
 * OUTPUT into, which is what makes the trail recursive), the delay is a value and the depth
 * the allocation (Cache's split), and a delay the ring cannot reach is clamped and SAID.
 */

type Values = Readonly<Record<string, ParameterValue>>;
type Pass = PassDescriptor & {
  target: string;
  textures?: ReadonlyArray<{ binding: string; resourceId: string; array?: boolean }>;
  uniforms?: Record<string, unknown>;
};

const compiled = (parameters: Values = {}) => echoNode.compile(compileContext({ inputs: ["input"], parameters }));
const passes = (parameters: Values = {}) => compiled(parameters).passes as ReadonlyArray<Pass>;

describe("Echo (T1402b)", () => {
  it("registers with no manifest diagnostics", () => {
    expect(validateNodeDefinition(echoNode)).toEqual([]);
    expect(createNodeRegistry([echoNode]).list().map((d) => d.type)).toEqual(["echo"]);
  });

  it("reads its ring and the input into the output, then archives the OUTPUT, not the input", () => {
    const ring = scratchResourceId("n1", ECHO_RING_KEY);
    const [echo, record] = passes({ delay: 1 });
    expect(echo?.target).toBe(outputResourceId("out"));
    expect(echo?.textures).toEqual([
      { binding: "inputTexture", resourceId: inputResourceId("input") },
      { binding: "ringTexture", resourceId: ring, array: true },
    ]);
    // Archiving the input would make every echo a copy of the raw past — a trail one step
    // long. Archiving the output is what makes each echo carry the ones before it.
    expect(record?.target).toBe(ring);
    expect(record?.textures).toEqual([{ binding: "inputTexture", resourceId: outputResourceId("out") }]);
    expect(compiled().scratch).toEqual([{ key: ECHO_RING_KEY, kind: "ring", frames: ECHO_DEFAULT_FRAMES }]);
  });

  it("keeps the delay a value: driving it moves no structure (§V5)", () => {
    const at = (delay: number) => passes({ delay, frames: 8 }).map(passStructureKey);
    expect(at(5)).toEqual(at(1));
    expect(passes({ delay: 5, frames: 8 })[0]?.uniforms?.["tap"]).toBe(5);
  });

  it("clamps a delay deeper than its history, and says so", () => {
    const result = compiled({ delay: 4, frames: 2 });
    expect((result.passes[0] as Pass).uniforms?.["tap"]).toBe(1);
    expect(result.diagnostics?.[0]?.code).toBe("node.compile.tapClamped");
    expect(compiled({ delay: 1, frames: 2 }).diagnostics).toBeUndefined();
  });
});
