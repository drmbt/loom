import { describe, expect, it } from "vitest";

import { evaluateExpression, parseExpression } from "./evaluate.ts";
import { formatParentRead, parentReadsOf, rewriteParentReads } from "./parent-reads.ts";

describe("VN36 — parent() in the grammar", () => {
  it("parses parent() as one hop and parent(n) as n, reading .par.key and one component", () => {
    expect(parseExpression("parent().par.gain")).toEqual({
      ok: true,
      ast: { kind: "parentRef", hops: 1, path: ["par", "gain"], at: 0, end: 17 },
    });
    const two = parseExpression("parent(2).par.tint.r * 0.5");
    expect(two.ok && two.ast.kind === "binary" ? two.ast.left : null).toMatchObject({ kind: "parentRef", hops: 2, path: ["par", "tint", "r"] });
  });

  it("keeps a bare `parent` a variable name; only `parent(` is the read", () => {
    expect(evaluateExpression("parent * 2", { parent: 3 })).toEqual({ ok: true, value: 6 });
  });

  it.each([
    ["parent()", "must read a parameter"],
    ["parent().chan.value", "parameters only (.par)"],
    ["parent().par", "name one parameter"],
    ["parent().par.color.r.x", "name one parameter"],
    ["parent(0).par.gain", "counts components outward from 1"],
    ["parent(1.5).par.gain", "counts components outward from 1"],
    ["parent('rig').par.gain", "takes nothing, or how many"],
    ["parent(1, 2).par.gain", "takes nothing, or how many"],
  ])("refuses %s as syntax, saying what to write", (source, reason) => {
    const parsed = parseExpression(source);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.kind).toBe("syntax");
      expect(parsed.reason).toContain(reason);
    }
  });

  it("never evaluates to a number outside a component: it fails as unreadable, with the reason", () => {
    const evaluated = evaluateExpression("parent().par.gain + 1", {}, () => ({ ok: true, value: 0 }));
    expect(evaluated).toMatchObject({ ok: false, kind: "reference.unreadable" });
    if (!evaluated.ok) expect(evaluated.reason).toContain("not inside one");
  });
});

describe("VN36 — parent() reads by span", () => {
  it("finds every read, nested in calls and operators, with spans into the source as given", () => {
    const source = "  clamp(parent().par.gain, 0, parent(2).par.max) + op('parent().par.x').par.y";
    const reads = parentReadsOf(source);
    expect(reads.map((read) => source.slice(read.at, read.end))).toEqual(["parent().par.gain", "parent(2).par.max"]);
    expect(reads.map(({ hops, key, component }) => ({ hops, key, component }))).toEqual([
      { hops: 1, key: "gain", component: undefined },
      { hops: 2, key: "max", component: undefined },
    ]);
  });

  it("reads nothing from a source that does not parse", () => {
    expect(parentReadsOf("parent().par.gain +")).toEqual([]);
  });

  it("rewrites in place, right to left, and leaves a read the caller declines as written", () => {
    const source = "parent().par.gain * 2 + parent(2).par.gain";
    const rewritten = rewriteParentReads(source, (read) => (read.hops === 1 ? "op('rig1').par.gain" : undefined));
    expect(rewritten).toBe("op('rig1').par.gain * 2 + parent(2).par.gain");
  });

  it("formats a read the way the grammar parses it", () => {
    for (const read of [{ hops: 1, key: "gain", component: undefined }, { hops: 3, key: "tint", component: "g" }]) {
      const [parsed] = parentReadsOf(formatParentRead(read));
      expect(parsed).toMatchObject(read);
    }
  });
});
