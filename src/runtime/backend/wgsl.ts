/**
 * T1335b — THE SEAM THAT MAKES "DO NOT REGENERATE SHADER TEXT EVERY FRAME" A TYPE RATHER
 * THAN A RULE.
 *
 * ## The problem this replaces
 *
 * §T259 runs the whole compiler EVERY FRAME for any animated document, and a node's
 * `compile()` builds the WGSL it hands to its pass. Emission therefore conflates "this
 * node's VALUES changed" with "this node's SOURCE changed", and the second almost never
 * happens: §T1333b measured `src/points/codegen.ts` at 39.4% of ALL main-thread script time
 * on E32 Pasture, rebuilding text from bytes that were identical sixty times a second.
 *
 * Two of those were fixed by hand. That is not a fix — it is a rule somebody has to
 * remember, and the owner said so: *"this needs to be ABSTRACTED AWAY so that it's not a
 * rule that is written down that we have to respect, but something that is AUTOMATICALLY
 * APPLIED wherever it is useful."*
 *
 * ⚑ **AND AN AUDIT CANNOT BE THE ANSWER (§V1012).** Which emitter is expensive is a
 * property of the DOCUMENT, not of the emitter: E32 puts 39.4% of script in the point
 * kernel and never touches the shared-module resolver; E55 Reactor does the reverse at
 * 3.37%; E24 makes neither measurable. A list of hot sites is a snapshot of one
 * `.loom.json`. An audit fixes the documents somebody measured; a seam fixes the ones
 * nobody has written yet.
 *
 * ## The design test, and how it is met
 *
 * A contributor who has never read any of this must not be able to write a
 * per-frame-regenerating emitter that TYPECHECKS. So the pass descriptors in
 * `runtime/backend/plan.ts` do not take a `string` — they take `EmittedWgsl`, which only
 * this module can produce. A raw template literal is not assignable, and the compiler
 * refuses the uncached path for free, forever.
 *
 * ## Why the KEY is the tagged template, and not what was proposed first
 *
 * The obvious cache is a `WeakMap` on the emitter's request object. Measured at
 * `point-kernel-advanced.ts:274` and it would have missed EVERY FRAME: the request is a
 * fresh object literal inside `compile()`, with its arrays and its kernel body rebuilt per
 * call. It would have looked like a working cache and cached nothing.
 *
 * A tagged template's `TemplateStringsArray` is, by the language's own guarantee, the SAME
 * frozen object on every evaluation of that call site. So the site itself is the key root —
 * no stringify, no hashing, no copying a five-kilobyte kernel body to build a key, and
 * nothing to keep in sync. The interpolated values walk a small trie below it.
 *
 * Anything the `WeakMap` holds dies with the module that owns the call site, so the cache
 * is bounded by construction rather than by a policy; the per-level cap below bounds the
 * one case that is not — a site interpolated with unboundedly many distinct values.
 *
 * ## What this covers, and what it deliberately does not
 *
 * It covers every WGSL string that reaches a pass descriptor. It does NOT cover expression
 * compilation or parameter reflection: the same shape, already memoised through
 * `params-reflection.ts`'s `remember`, and branding every string in the application is a
 * different project. If those should live under one seam it is a row of its own, argued
 * rather than assumed.
 *
 * ## ⚠ THE LIMIT OF THE BRAND, AND IT WAS FOUND THE EMBARRASSING WAY
 *
 * `EmittedWgsl` is a BRANDED STRING, so the type gate runs in one direction only: it stops a
 * raw literal REACHING a pass, and it cannot stop a non-shader BEING BRANDED. The guarantee
 * is therefore only as narrow as the set of things wearing the brand, and every careless tag
 * widens it.
 *
 * That is not hypothetical. The landing commit branded seven helpers that emit no WGSL at
 * all — two inspector dropdown labels in `matte.ts`, a cost label, a byte-size label, two
 * resource ids and a pass id — because they were converted by a pattern over
 * `): string {` rather than by reading them. Under that commit, a matte dropdown label was
 * assignable to a pass descriptor's `shader`. Nothing failed, which is the point: the
 * compiler cannot tell UI copy from shader source once the tag is on.
 *
 * So the rule the type cannot carry, stated here because it is the one a reviewer has to:
 * **tag a string only where WGSL is what it is.** If the answer to "would Dawn compile this?"
 * is no, it is a `string`.
 */

declare const emitted: unique symbol;

/**
 * WGSL that came from this module, and therefore from a cache. The brand is phantom — at
 * runtime this IS the string, so every existing reader keeps working unchanged.
 */
export type EmittedWgsl = string & { readonly [emitted]: true };

/** What may be interpolated into a shader template: things a `Map` can key by value. */
export type WgslValue = string | number | boolean;

interface SiteNode {
  text?: EmittedWgsl;
  children?: Map<WgslValue, SiteNode>;
}

/**
 * Distinct value-combinations remembered per call site, matching `remember`'s own cap for
 * the same reason: a shader editor types a new source per keystroke, and a cache that
 * remembers every one of them is a leak with a docblock.
 */
const SITE_CACHE_LIMIT = 64;

const bySite = new WeakMap<TemplateStringsArray, SiteNode>();

/** T1603b: how many texts `wgsl` and `emitFrom` have BUILT (a lookup that hit builds none). */
let textsBuilt = 0;

/**
 * Build WGSL, once per distinct set of interpolated values per call site.
 *
 *     const shader = wgsl`fn main() { let k = ${gain}; }`;
 *
 * Writing the natural thing is what gets the cache, which is the whole point: there is no
 * second, slower spelling to avoid.
 */
export function wgsl(strings: TemplateStringsArray, ...values: readonly WgslValue[]): EmittedWgsl {
  const root = bySite.get(strings);
  let node: SiteNode;
  if (root === undefined) {
    node = {};
    bySite.set(strings, node);
  } else {
    node = root;
  }
  for (const value of values) {
    const existing = node.children;
    let children: Map<WgslValue, SiteNode>;
    if (existing === undefined) {
      children = new Map<WgslValue, SiteNode>();
      node.children = children;
    } else {
      children = existing;
    }
    const found = children.get(value);
    let child: SiteNode;
    if (found !== undefined) {
      child = found;
    } else {
      child = {};
      children.set(value, child);
      /* Insertion order is age; the oldest goes. `child` is already held, so evicting it
         on the very call that created it would still return the right text — it would only
         cost the next call a rebuild. */
      if (children.size > SITE_CACHE_LIMIT) {
        const oldest = children.keys().next();
        if (oldest.done !== true) children.delete(oldest.value);
      }
    }
    node = child;
  }
  const hit = node.text;
  if (hit !== undefined) return hit;
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    text += String(values[index]) + (strings[index + 1] ?? "");
  }
  textsBuilt += 1;
  node.text = text as EmittedWgsl;
  return node.text;
}

/**
 * A GENERATOR's output, keyed by the inputs the generator actually varies on.
 *
 * `wgsl` covers the common case — a template with values interpolated into it — but a code
 * generator does not interpolate, it LOOPS: the point kernel walks an attribute schema and a
 * storage map and assembles hundreds of lines. There is no template object to key on, so the
 * caller declares its key, and declaring it is the price of getting branded text back. That
 * keeps the invariant the brand exists for — no emitter reaches a pass descriptor without a
 * cache — while admitting that one class of emitter cannot be keyed by its call site.
 *
 * ⚠ **THE KEY IS THE CALLER'S PROMISE, and an incomplete one ships a stale shader that passes
 * every identity test perfectly.** That failure mode is why the invalidation, not the hit, is
 * the case worth a test (§V968): change a generator input, assert the RENDERED PIXELS move.
 * A key that names every structural input is correct; one that forgets a flag is a silent
 * defect a type cannot catch.
 */
export function emitFrom(keys: readonly WgslValue[], build: () => string): EmittedWgsl {
  let node = byGenerator;
  for (const key of keys) {
    const existing = node.children;
    let children: Map<WgslValue, SiteNode>;
    if (existing === undefined) {
      children = new Map<WgslValue, SiteNode>();
      node.children = children;
    } else {
      children = existing;
    }
    const found = children.get(key);
    if (found !== undefined) {
      node = found;
      continue;
    }
    const child: SiteNode = {};
    children.set(key, child);
    if (children.size > SITE_CACHE_LIMIT) {
      const oldest = children.keys().next();
      if (oldest.done !== true) children.delete(oldest.value);
    }
    node = child;
  }
  const hit = node.text;
  if (hit !== undefined) return hit;
  textsBuilt += 1;
  node.text = build() as EmittedWgsl;
  return node.text;
}

/**
 * Generators share one root rather than a per-site `WeakMap`, because their key already
 * names the generator (every caller leads with its own name) and a generator is not a
 * template object that can die with its module.
 */
const byGenerator: SiteNode = {};

/**
 * THE TRUST BOUNDARY: a plan that was BUILT ELSEWHERE, being read back.
 *
 * `plan.ts`'s readers take `unknown` and validate it into descriptors. The text in such a
 * plan was emitted by a node's `compile()` when the plan was first built — this only
 * re-labels it after a round trip, and it generates nothing.
 *
 * ⚠ It is not a way to get branded text out of a string you just assembled. A `compile()`
 * that reaches for this is writing the uncached emitter the brand exists to refuse, and the
 * name is deliberately unusable there: nothing in `src/nodes/**` should import it.
 */
export function wgslFromPlan(text: string): EmittedWgsl {
  return text as EmittedWgsl;
}

/**
 * WGSL THE USER WROTE, or that a document carries — a `customWgsl` source, a point kernel.
 *
 * There is nothing to memoise here and the brand is honest rather than a loophole: the text
 * is not BUILT per frame, it IS the parameter, handed over from the store as the same string
 * every frame. What the caller must not do is assemble text and launder it through this;
 * that is what `wgsl` is for, and the two names are deliberately different so a reviewer can
 * see which one a diff chose.
 */
export function authoredWgsl(source: string): EmittedWgsl {
  return source as EmittedWgsl;
}

/**
 * T1603b — A WHOLE GENERATOR, remembered by EVERYTHING it was handed.
 *
 * ## What `wgsl` and `emitFrom` leave on the table
 *
 * They remember the final string. A generator that ASSEMBLES — the lit surface module,
 * a depth sweep, a point kernel — does its work before it has a string to look up: it
 * builds a dozen intermediate strings, and `wgsl` then hashes those fresh kilobytes to find
 * the text it already had. Profiled on a scene of thirteen geometries with shadows, that
 * assembly was more than half of the per-frame values-only compile (§T1603b,
 * `docs/geometry-cost-profile-2026-10-05.md`), all of it for text a values-only frame
 * cannot change.
 *
 * So this wraps the generator itself. Called again with the same arguments it returns the
 * same result and runs nothing.
 *
 * ## The key is DERIVED, never declared
 *
 * A stale shader after a structural edit is the failure this could introduce, and it would
 * pass every identity test perfectly. `emitFrom` makes the caller list its key, and a list
 * is one forgotten flag away from that. Here the key is a walk of the ARGUMENTS THEMSELVES:
 * every property of every options object, every element of every array, in order. An option
 * added to a generator next year is in the key the day it is added, because nobody has to
 * remember to put it there. A generator reads nothing but its arguments and module
 * constants (it is a pure function, which is what makes this legal at all), so the walk is
 * everything the text can depend on.
 *
 * What the walk cannot describe it REFUSES, by throwing: a function, a class instance, a
 * symbol. An argument whose content the key ignored would be exactly the forgotten flag.
 *
 * ## The walk IS the lookup
 *
 * No key string is built. The walk descends a trie, one step per value: a primitive is its
 * own step (a `Map` keys numbers, strings and booleans apart by value), an array announces
 * its length, an object its property names and a closing mark — so two different
 * structures cannot arrive at the same node. A key string was built first and measured at
 * 0.94 ms a frame on that scene (350 calls), half of it flattening and hashing five hundred
 * characters per call to find a result the walk had already identified; the trie is 0.55.
 * A long string (a shader body) costs one hash for the life of the string object.
 *
 * ## The result is SHARED
 *
 * Every caller gets the same object back, frame after frame, so it is frozen, deeply, the
 * one time it is made. A caller that tried to edit one would be editing every other pass's
 * copy; now it throws instead.
 *
 * `src/compiler/generated-text.test.ts` holds the two halves: a values-only frame generates
 * nothing, and every structural parameter that changes a text still changes it.
 */
export function generatedOnce<Args extends readonly unknown[], Result>(
  name: string,
  generate: (...args: Args) => Result,
): (...args: Args) => Result {
  const memo: GeneratorMemo = { root: {}, results: 0, generated: 0, reused: 0 };
  generators.set(name, memo);
  return (...args: Args): Result => {
    let node = memo.root;
    for (let index = 0; index < args.length; index += 1) node = descend(node, args[index]);
    // A call with fewer arguments must not land on the node of a longer one's prefix.
    node = step(node, END);
    if (node.made === true) {
      memo.reused += 1;
      return node.result as Result;
    }
    const made = deepFreeze(generate(...args));
    memo.generated += 1;
    node.made = true;
    node.result = made;
    memo.results += 1;
    if (memo.results > GENERATED_LIMIT) {
      // Dropped whole: the next frame regenerates what it uses, once, as a first frame does.
      memo.root = {};
      memo.results = 0;
    }
    return made;
  };
}

/**
 * Distinct results remembered per generator. A document's working set is its distinct
 * passes — tens to a few hundred — and each is ten to twenty kilobytes; the cap is what a
 * shader editor's keystrokes run into, one new text per stroke per pass that wears it.
 */
const GENERATED_LIMIT = 1024;

interface MemoNode {
  next?: Map<unknown, MemoNode>;
  made?: boolean;
  result?: unknown;
}

interface GeneratorMemo {
  root: MemoNode;
  results: number;
  generated: number;
  reused: number;
}

const generators = new Map<string, GeneratorMemo>();

/* Structure marks: steps no value can take, so content cannot forge a boundary. */
const ARRAY = Symbol("array");
const OBJECT = Symbol("object");
const MAP = Symbol("map");
const SET = Symbol("set");
const END = Symbol("end");

function step(node: MemoNode, token: unknown): MemoNode {
  let next = node.next;
  if (next === undefined) {
    next = new Map<unknown, MemoNode>();
    node.next = next;
  }
  let child = next.get(token);
  if (child === undefined) {
    child = {};
    next.set(token, child);
  }
  return child;
}

/**
 * One value's walk down the trie. Property order is the order the object was built in; two
 * objects with the same content in another order arrive at different nodes, which costs a
 * regeneration and can never return the wrong text.
 */
function descend(node: MemoNode, value: unknown): MemoNode {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error(`generatedOnce: a ${typeof value} cannot be part of a generator's key; pass plain data.`);
    }
    return step(node, value);
  }
  let at = node;
  if (Array.isArray(value)) {
    at = step(step(at, ARRAY), value.length);
    for (let index = 0; index < value.length; index += 1) at = descend(at, value[index]);
    return at;
  }
  if (value instanceof Map) {
    at = step(step(at, MAP), value.size);
    for (const [key, item] of value) at = descend(descend(at, key), item);
    return at;
  }
  if (value instanceof Set) {
    at = step(step(at, SET), value.size);
    for (const item of value) at = descend(at, item);
    return at;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`generatedOnce: a ${(prototype as { constructor?: { name?: string } }).constructor?.name ?? "non-plain"} object cannot be part of a generator's key; pass plain data.`);
  }
  at = step(at, OBJECT);
  for (const name in value) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    at = descend(step(at, name), (value as Record<string, unknown>)[name]);
  }
  return step(at, END);
}

/**
 * How many times each wrapped generator has RUN and how many times it was answered from
 * memory, and how many texts the template tag built, since the process started. The gate
 * for "a values-only frame builds no shader text" reads this around a frame and expects
 * neither `generated` nor `built` to move; the per-name form is what makes its failure say
 * which generator ran.
 */
export function generatedTextCounts(): {
  readonly generated: number;
  readonly reused: number;
  /** Texts the `wgsl` tag and `emitFrom` built: every emitter that is not a wrapped generator. */
  readonly built: number;
  readonly byGenerator: Readonly<Record<string, { readonly generated: number; readonly reused: number }>>;
} {
  let generated = 0;
  let reused = 0;
  const byGenerator: Record<string, { generated: number; reused: number }> = {};
  for (const [name, memo] of generators) {
    generated += memo.generated;
    reused += memo.reused;
    byGenerator[name] = { generated: memo.generated, reused: memo.reused };
  }
  return { generated, reused, built: textsBuilt, byGenerator };
}

/**
 * Forget every remembered result: the next call of each generator runs it. For the tests
 * that compare a remembered text with a freshly generated one — which is the only way a
 * stale one can be seen. Nothing in the product calls it. (The template tag's own texts are
 * not forgotten: they are keyed by every value interpolated, which is their whole input.)
 */
export function forgetGeneratedText(): void {
  for (const memo of generators.values()) {
    memo.root = {};
    memo.results = 0;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  // A Map or a Set cannot be frozen into immutability; a generator that returns one is trusted
  // as before. Plain objects and arrays, which is what every generator here returns, are.
  if (value instanceof Map || value instanceof Set) return value;
  Object.freeze(value);
  for (const item of Object.values(value as object)) deepFreeze(item);
  return value;
}
