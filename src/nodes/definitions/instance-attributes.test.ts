import { describe, expect, it } from "vitest";

import { bindInstanceAttributes, INSTANCE_ATTRIBUTE_CODE } from "./instance-attributes.ts";
import type { PointsetAttributeRef } from "../../domain/types/node-definition.ts";

/**
 * T1581b (D9) — a material's `struct Instance` fields meet the points' attributes BY NAME.
 *
 * The rule under test is the one a person relies on when a glow does not show: every way a
 * field can fail to find its value is SAID, with what the two sides actually have — never a
 * plausible zero. What a bound field then paints is `mesh-instances.gpu.test.ts`'s claim.
 */

const pair = (type: string, offset: number): PointsetAttributeRef => ({ buffer: "pair:pts", half: "write", offset, bytes: 256, type });

/** What a kernel's pointset carries. */
const POINTS = {
  position: pair("vec3f", 0),
  glow: pair("f32", 256),
  ring: pair("u32", 512),
  shade: pair("vec3f", 768),
  heat: pair("f32", 1024),
  pick: pair("vec4f", 1280),
  uv: pair("vec2f", 1536),
};

const FIELDS = [
  { name: "glow", wgsl: "f32", default: [0.4] },
  { name: "ring", wgsl: "u32" },
  { name: "shade", wgsl: "vec3f", default: [0, 0, 0.2] },
];

const bind = (text: string, fields: typeof FIELDS | ReadonlyArray<{ name: string; wgsl: string; default?: number[] }> = FIELDS, pairs: Record<string, PointsetAttributeRef> = POINTS) =>
  bindInstanceAttributes("geo", text, fields, pairs);
const bound = (result: ReturnType<typeof bind>) => {
  if ("diagnostics" in result) throw new Error(result.diagnostics.map((d) => d.message).join(" | "));
  return result.bound.map((field) => `${field.name}:${field.type} <- ${field.sourceType}@${field.source.offset}${field.channel === undefined ? "" : `.${field.channel}`}`);
};
const refusal = (result: ReturnType<typeof bind>) => {
  if (!("diagnostics" in result)) throw new Error("expected a refusal, and it bound");
  expect(result.diagnostics.every((d) => d.code === INSTANCE_ATTRIBUTE_CODE && d.severity === "error" && d.nodeId === "geo")).toBe(true);
  return result.diagnostics.map((d) => `${d.message} ${d.suggestion ?? ""}`);
};

describe("binding a material's struct Instance to the points (T1581b)", () => {
  it("takes the attribute of the field's own name and type, with nothing written", () => {
    expect(bound(bind(""))).toEqual(["glow:f32 <- f32@256", "ring:u32 <- u32@512", "shade:vec3f <- vec3f@768"]);
  });

  it("renames with `field = attribute`, and takes one channel with `field = attribute.x`", () => {
    expect(bound(bind("glow = heat"))).toEqual(["glow:f32 <- f32@1024", "ring:u32 <- u32@512", "shade:vec3f <- vec3f@768"]);
    // Lines or semicolons; either channel alphabet.
    expect(bound(bind("glow = pick.z; shade = shade"))).toEqual(["glow:f32 <- vec4f@1280.z", "ring:u32 <- u32@512", "shade:vec3f <- vec3f@768"]);
    expect(bound(bind("\n  glow = uv.g\n"))).toEqual(["glow:f32 <- vec2f@1536.g", "ring:u32 <- u32@512", "shade:vec3f <- vec3f@768"]);
  });

  it("leaves a field on its declared default when the points carry no such attribute", () => {
    const { glow: _glow, shade: _shade, ...without } = POINTS;
    // `glow` and `shade` declare defaults and simply are not bound; `ring` still is.
    expect(bound(bind("", FIELDS, without))).toEqual(["ring:u32 <- u32@512"]);
  });

  it("binds nothing, and asks nothing, when the material declares no struct Instance", () => {
    expect(bind("", [])).toEqual({ bound: [] });
  });

  it("refuses a field with neither an attribute nor a default: it would have no value", () => {
    const { ring: _ring, ...without } = POINTS;
    const said = refusal(bind("", FIELDS, without));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('instance field "ring" finds no attribute "ring" on the points and declares no default');
    // … and says what the points do carry, so the misspelling is visible.
    expect(said[0]).toContain("glow (f32), heat (f32), pick (vec4f), position (vec3f), shade (vec3f), uv (vec2f)");
  });

  it("refuses a line that names what is not there, on either side", () => {
    expect(refusal(bind("glwo = heat"))[0]).toContain('binds "glwo", but the material\'s `struct Instance` has no such field. The material declares: glow (f32), ring (u32), shade (vec3f).');
    expect(refusal(bind("glow = haet"))[0]).toContain('binds "glow" to "haet", but the points carry no such attribute.');
    expect(refusal(bind("glow = heat", []))[0]).toContain('binds "glow", but the material declares no `struct Instance` to bind it to.');
    expect(refusal(bind("glow heat"))[0]).toContain('line "glow heat" is not "field = attribute" or "field = attribute.channel"');
  });

  it("refuses a type that does not match, and says how to fix the common case", () => {
    // By name: the points' `glow` is a vector here.
    const vector = refusal(bind("", FIELDS, { ...POINTS, glow: pair("vec3f", 256) }));
    expect(vector[0]).toContain('instance field "glow" is f32, but the points\' attribute "glow" is vec3f.');
    expect(vector[0]).toContain("`glow = glow.x`");
    // By a line: a u32 field handed a float.
    expect(refusal(bind("ring = heat"))[0]).toContain('instance field "ring" is u32, but the points\' attribute "heat" is f32.');
  });

  it("refuses a channel that cannot be taken", () => {
    expect(refusal(bind("shade = pick.x"))[0]).toContain('binds "shade" (vec3f) to "pick.x", but a channel is one f32 and the field is not.');
    expect(refusal(bind("glow = heat.x"))[0]).toContain('"heat" is f32, not a float vector');
    expect(refusal(bind("glow = uv.z"))[0]).toContain('"uv" is vec2f and has no .z');
    expect(refusal(bind("glow = pick.q"))[0]).toContain('"pick" is vec4f and has no .q');
  });

  it("says every fault at once, not the first", () => {
    expect(refusal(bind("glwo = heat; ring = haet; shade = pick.x"))).toHaveLength(3);
  });
});
