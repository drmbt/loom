import { describe, expect, it } from "vitest";
import { forgetGeneratedText, generatedOnce, generatedTextCounts, wgsl } from "./wgsl.ts";

/**
 * T1335b — THE INVALIDATION, WHICH IS THE HALF A TYPE CANNOT CARRY.
 *
 * The brand guarantees shader text came from a cache. It guarantees nothing about that cache
 * being RIGHT, and a wrong one has the worst failure shape there is: a stale shader renders
 * the previous picture perfectly and every assertion about it passes. §V968's rule applies
 * exactly — the known positive worth testing is the INVALIDATION, not the hit.
 *
 * ⚑ AND THE HIT CANNOT BE TESTED FROM OUT HERE, WHICH IS WORTH STATING RATHER THAN FAKING.
 * A string is a primitive: `Object.is` on two equal strings is true whether the second came
 * from the cache or from a rebuild, so an identity assertion would be green under a cache
 * that never caches. (Two of the assertions in the first draft of this file claimed exactly
 * that and were deleted when they failed for that reason — the test was wrong, not the
 * code.) What the cache actually bought is measured where it is visible: in the production
 * CPU profile, where `src/points/codegen.ts` went from 39.4% of script to 1.2% (§T1333b).
 * These claims are about CORRECTNESS under change, and `wgsl-invalidation.gpu.test.ts`
 * carries the same one through the real stack in pixels.
 *
 * Red-verified by pinning the key: collapse the trie walk in `wgsl` to one node per call
 * site — ignoring the interpolated values, which is the plausible bug — and every claim
 * below goes red on the second distinct value.
 */

function emit(value: string | number): string {
  return wgsl`fn main() { let k = ${value}; }`;
}

describe("T1335b — emitted WGSL is keyed by call site AND by every value", () => {
  it("gives DIFFERENT text when an interpolated value changes", () => {
    expect(emit(1)).toBe("fn main() { let k = 1; }");
    expect(emit(2)).toBe("fn main() { let k = 2; }");
  });

  it("gives the FIRST text back after a second value has been through — a cache that overwrote would not", () => {
    emit(1);
    emit(2);
    expect(emit(1)).toBe("fn main() { let k = 1; }");
  });

  it("keys on EVERY value, not just the first", () => {
    const two = (a: number, b: number): string => wgsl`${a}:${b}`;
    expect(two(1, 1)).toBe("1:1");
    expect(two(1, 2)).toBe("1:2");
    expect(two(2, 1)).toBe("2:1");
    expect(two(1, 1)).toBe("1:1");
  });

  it("keeps two call sites apart even when one has been evaluated and the other has not", () => {
    const here = wgsl`site A`;
    const there = wgsl`site B`;
    expect(here).toBe("site A");
    expect(there).toBe("site B");
  });

  it("stays correct after a site has been interpolated with far more values than it can hold", () => {
    // The per-site cap is 64. Eviction may drop any of these; correctness may not depend on
    // which, so the claim is that the TEXT is still right on both sides of the cap.
    for (let index = 0; index < 300; index += 1) emit(index);
    expect(emit(299)).toBe("fn main() { let k = 299; }");
    expect(emit(0)).toBe("fn main() { let k = 0; }");
  });
});

/**
 * T1603b — `generatedOnce`: a whole generator remembered by everything it was handed.
 *
 * The key is a walk of the arguments, so the claims are about that walk: the same structure
 * finds the same result and runs nothing; ANY difference in the structure runs the generator
 * again; and no two different structures can spell the same key. The last is the stale
 * shader this could ship, so it is asked the adversarial way — values chosen so that a
 * naive key (a join, a JSON without types, a flattening) would collide.
 *
 * Unlike a string, a result OBJECT has identity, so here the hit is testable from outside:
 * the generator's own call count is the claim.
 */
describe("T1603b — a generator runs once per distinct structure of its arguments", () => {
  /** A generator that counts its runs and returns what it was called with, as text. */
  function counted(): { run: (...args: unknown[]) => { text: string; list: number[] }; runs: () => number } {
    let runs = 0;
    const run = generatedOnce(`test:${String(nextName++)}`, (...args: unknown[]) => {
      runs += 1;
      return { text: JSON.stringify(args), list: [runs] };
    });
    return { run, runs: () => runs };
  }
  let nextName = 0;

  it("runs nothing the second time, and hands back the same result", () => {
    const { run, runs } = counted();
    const options = () => ({ model: "pbr", lights: 2, maps: { albedo: true }, shadows: [0, 2], code: "x".repeat(5000) });
    const first = run(options());
    // A FRESH object with the same content: what a per-frame compile hands a generator.
    expect(run(options())).toBe(first);
    expect(run(options(), undefined)).not.toBe(first); // another argument list is another call
    expect(runs()).toBe(2);
  });

  it("runs again for ANY difference, however deep", () => {
    const { run, runs } = counted();
    const base = { model: "pbr", lights: 2, maps: { albedo: true }, shadows: [0, 2], custom: { code: "a".repeat(200), fields: [{ name: "glow", wgsl: "f32" }] } };
    const variants: unknown[] = [
      base,
      { ...base, model: "phong" },
      { ...base, lights: 3 },
      { ...base, maps: { albedo: false } },
      { ...base, maps: { albedo: true, roughness: true } },
      { ...base, shadows: [0, 3] },
      { ...base, shadows: [0, 2, 0] },
      { ...base, custom: { ...base.custom, code: `${"a".repeat(199)}b` } },
      { ...base, custom: { ...base.custom, fields: [{ name: "glow", wgsl: "vec3f" }] } },
      { ...base, custom: { ...base.custom, fields: [] } },
      { ...base, added: undefined }, // a key that is PRESENT is not a key that is absent
    ];
    const results = variants.map((variant) => run(variant));
    expect(new Set(results).size).toBe(variants.length);
    expect(runs()).toBe(variants.length);
    // And each is still found afterwards: a later variant did not overwrite an earlier one.
    variants.forEach((variant, index) => expect(run(variant)).toBe(results[index]));
    expect(runs()).toBe(variants.length);
  });

  it("cannot be made to mistake one structure for another", () => {
    const { run, runs } = counted();
    // Pairs a careless key would join into the same string.
    const pairs: Array<[unknown[], unknown[]]> = [
      [["ab", "c"], ["a", "bc"]],
      [[["a", "b"]], ["a", "b"]],
      [[1], ["1"]],
      [[true], ["true"]],
      [[null], [undefined]],
      [[null, 0], ["null", 0]],
      [[undefined, 0], ["undefined", 0]],
      [[[]], [{}]],
      [[[1, 2], 3], [[1], 2, 3]],
      [[{ a: 1, b: 2 }], [{ a: { b: 2 } }]],
      [[{ a: "b" }], [{ a: undefined, b: undefined }]],
      [[{ a: [1], b: 2 }], [{ a: [1, "b", 2] }]],
      [[{ a: {} }, 1], [{ a: { 1: undefined } }]],
      [[{ ab: 1 }], [{ a: "b", 1: 1 }]],
      [[[2, "x"]], [["x", "x"]]],
      [[new Map([["a", 1]])], [{ a: 1 }]],
      [[new Set([1, 2])], [[1, 2]]],
      [[0.1 + 0.2], [0.3]],
    ];
    for (const [left, right] of pairs) {
      const before = runs();
      const a = run(...left);
      const b = run(...right);
      expect([JSON.stringify(left), JSON.stringify(right), a === b]).toEqual([JSON.stringify(left), JSON.stringify(right), false]);
      expect(runs() - before).toBe(2);
    }
  });

  it("refuses what it cannot describe, rather than ignore it", () => {
    const { run } = counted();
    expect(() => run({ shade: () => 1 })).toThrow(/a function cannot be part of a generator's key/);
    expect(() => run({ at: new Date(0) })).toThrow(/a Date object cannot be part of a generator's key/);
    expect(() => run([Symbol("s")])).toThrow(/a symbol cannot be part of a generator's key/);
  });

  it("hands back a result nobody can edit: it is every caller's copy", () => {
    const { run } = counted();
    const result = run({ a: 1 });
    expect(() => {
      (result as { text: string }).text = "edited";
    }).toThrow(TypeError);
    expect(() => result.list.push(2)).toThrow(TypeError);
    expect(run({ a: 1 }).text).toBe('[{"a":1}]');
  });

  it("counts what ran and what did not, and forgets on request", () => {
    const { run, runs } = counted();
    const before = generatedTextCounts();
    run({ a: 1 });
    run({ a: 1 });
    run({ a: 2 });
    const after = generatedTextCounts();
    expect([after.generated - before.generated, after.reused - before.reused]).toEqual([2, 1]);
    // Forgotten: the same arguments run the generator again, and give an equal, new result.
    const remembered = run({ a: 1 });
    forgetGeneratedText();
    const again = run({ a: 1 });
    expect(again).not.toBe(remembered);
    expect(again.text).toBe(remembered.text);
    expect(runs()).toBe(3);
  });

  it("counts a template's text as built once, however often it is asked for", () => {
    const site = (value: number): string => wgsl`counted ${value}`;
    const before = generatedTextCounts().built;
    site(41);
    site(41);
    site(42);
    expect(generatedTextCounts().built - before).toBe(2);
  });

  it("stays correct past its cap: more distinct structures than it remembers", () => {
    const { run } = counted();
    for (let index = 0; index < 1100; index += 1) run({ index });
    expect(run({ index: 0 }).text).toBe('[{"index":0}]');
    expect(run({ index: 1099 }).text).toBe('[{"index":1099}]');
  });
});
