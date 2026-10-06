import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LIGHT_GUARD_ABOVE,
  sceneInstancesWgsl,
  sceneSurfaceWgsl,
  type SceneShadingOptions,
} from "../shaders/scene-render.wgsl.ts";

/**
 * B260 — THE LIT SUM MUST NOT BE ONE STRAIGHT CHAIN THROUGH MANY LIGHTS.
 *
 * What was measured (`docs/light-cost-investigation-2026-10-06.md`): a lit fragment function
 * that adds every light's terms into `lit` in one straight line is rearranged by Apple's
 * Metal compiler (fast math) so that every light's values are live at once. Past the GPU's
 * registers the cost per fragment jumps and then grows faster than the light count: 37 Light
 * nodes cost the consumer's document 18.4 ms of GPU where the guarded text costs 8.6.
 *
 * So the gate is on the CAUSE, read off the text the generators emit, and not on a clock:
 * in no lit fragment function do more than `LIGHT_GUARD_ABOVE` sources in a row add into
 * `lit` in the same straight-line scope. A source whose additions sit under a branch on a
 * value the compiler cannot know ends the run: after it `lit` is a merge of two paths, and
 * a sum cannot be rearranged across a merge.
 *
 * A source is a Light or a PROJECTOR: a projector adds into the same sum. Its addition has
 * always sat under two tests of the fragment's own place (in front of the lens, inside the
 * frustum), and 8 lights with 24 projectors were measured to cost what the projectors cost
 * one by one. The gate counts projectors so that this stays true by rule and not by the
 * accident of how the block happens to be written.
 *
 * The other half is what the stopgap promised: at and below the threshold the text is what
 * main emitted before it, byte for byte.
 *
 * WHAT IT COUNTS SINCE T1623b SLICE 3. A Render's lit Surface draw walks its light table and
 * unrolls a block for a CASTING Light alone, so the scan has two more things to see:
 *
 *  - A ROW of the table is a source like a Light's block: every place in the text that
 *    shades a row counts as one (the turn of the rows of any kind, each row of a turn of the
 *    point lights' and of the suns' loops, the turn of a cell's bits).
 *  - The texts scanned include the Surface generator's WITH the table, at 0 to 32 casting
 *    blocks. There every block is under its guard at every count, and no two sources stand
 *    in one straight line at all: the longest run the gate sees is 1.
 *
 * The threshold `LIGHT_GUARD_ABOVE` is what it was, and is now the rule for the texts that
 * have NO table: the instances generator's (every Light in Single mode is still a block
 * there, until slice 7), a tile's preview (two stock lights) and the shadow matte.
 */

const ADDS_INTO_LIT = /^\s*lit\s*(\+=|=\s*lit\s*\+)/;
/** A source's block reads its own numbered uniform row first: `params.light3Meta`, `params.projector0Matrix`. */
const OPENS_A_SOURCE = /^\s*let\s+\w+\s*=\s*params\.(light|projector)(\d+)(Meta|Matrix)\b/;
/** A row of the light table is handed to the same block as three expressions: its `lightMeta` is built, not read off `params`. */
const OPENS_A_ROW = /^\s*let\s+lightMeta\s*=\s*vec4f\(/;

interface Scope {
  /** A branch on a runtime value: what it adds into `lit` is merged, not chained, with what follows. */
  readonly branch: boolean;
  /** The light or projector whose block this scope is, when it is one. */
  source?: string;
  /** The sources that have added into `lit` in this straight line since the last merge. */
  run: Set<string>;
  /** Something inside this scope added into `lit`. */
  added: boolean;
  /** This scope declares its own `lit` (a point shadow's tap count is named so): not the sum. */
  ownLit: boolean;
}

/** Whether the text in front of a `{` opens a branch the compiler cannot fold away. */
function opensABranch(head: string): boolean {
  if (/^(else|loop)$/.test(head) || /^(for|while)\b/.test(head)) return true;
  const tested = /^(?:else\s+)?(?:if|switch)\b(.*)$/s.exec(head);
  /* A test with no name in it (`if (true)`, `if (1.0 > 0.5)`) is a constant: no branch survives it. */
  return tested !== null && /[A-Za-z_]/.test((tested[1] ?? "").replace(/\b(true|false)\b/g, ""));
}

/**
 * The longest run of sources adding into `lit` in one straight-line scope of the module's
 * fragment function. Comments are dropped first, so a brace in prose is not a scope.
 */
function longestStraightRun(module: string): number {
  const code = module.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const entry = code.indexOf("@fragment");
  if (entry < 0) throw new Error("the module has no fragment stage");
  const body = code.slice(code.indexOf("{", entry));
  const scopes: Scope[] = [];
  /** The scope a straight line of additions belongs to: the nearest branch, or the function. */
  const chain = (): Scope => {
    const found = scopes[Math.max(scopes.findLastIndex((scope) => scope.branch), 0)];
    if (found === undefined) throw new Error("a statement outside the fragment function");
    return found;
  };
  let longest = 0;
  for (const [lineIndex, line] of body.split("\n").entries()) {
    /* Statements first, against the scope the line starts in; then the line's braces in order. */
    const at = scopes[scopes.length - 1];
    const source = OPENS_A_SOURCE.exec(line);
    if (source !== null && at !== undefined) at.source = `${source[1]}${source[2]}`;
    /* Each place in the text that shades a row of the table is a source of its own. */
    if (OPENS_A_ROW.test(line) && at !== undefined) at.source = `row@${lineIndex}`;
    if (/^\s*var\s+lit\b/.test(line) && at !== undefined) at.ownLit = true;
    /* The sum is the `lit` the function itself declares; a nested scope's own `lit` is another variable. */
    if (ADDS_INTO_LIT.test(line) && scopes.findLastIndex((scope) => scope.ownLit) === 0) {
      const owner = scopes.findLast((scope) => scope.source !== undefined)?.source;
      const straight = chain();
      for (const scope of scopes.slice(scopes.indexOf(straight))) scope.added = true;
      if (owner !== undefined) straight.run.add(owner);
      longest = Math.max(longest, straight.run.size);
    }
    let since = 0;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === "{") {
        scopes.push({ branch: scopes.length > 0 && opensABranch(line.slice(since, index).trim()), run: new Set(), added: false, ownLit: false });
        since = index + 1;
      } else if (char === "}") {
        const closed = scopes.pop();
        if (closed === undefined) throw new Error("unbalanced braces in the fragment function");
        if (scopes.length === 0) return longest;
        if (closed.added) {
          (scopes[scopes.length - 1] as Scope).added = true;
          /* What a branch added is merged into what follows: the straight line starts again. */
          if (closed.branch) chain().run.clear();
        }
        since = index + 1;
      }
    }
  }
  throw new Error("the fragment function does not close");
}

/* The generators' feature options, each named. "Every feature" is the run a Material · WGSL's
   reserved names are derived from (`ALL_SURFACE_FEATURES`), which holds the most values live. */
const CUSTOM = { code: "fn surface(s: SurfaceIn, p: Params) -> SurfaceOut { return surfaceDefaults(s); }", paramsDeclaration: "", fields: [] } as const;
const read = (group: number, type = "vec4f") => ({ group, offset: 0, type });
const INSTANCED = {
  groups: 2,
  position: read(0, "vec3f"),
  normal: read(0, "vec3f"),
  uv: read(0, "vec2f"),
  color: read(0),
  surface: read(0),
  emissive: read(0, "vec3f"),
  record: { group: 1, m0: 0, m1: 0, m2: 0, visible: 0, tint: 0 },
} as never;
/** More projectors than the threshold (asserted below), of both kinds: with a cookie and an occlusion map, and bare. */
const MANY_PROJECTORS = Array.from({ length: 12 }, (_, index) => ({ cookie: index % 2 === 0, occlusion: index % 3 === 0 }));

type SurfaceCase = Omit<SceneShadingOptions, "lightCount">;
/** Shadows on the first two lights (one directional, one point) once there are that many. */
const casting = (lightCount: number): Partial<SceneShadingOptions> =>
  lightCount < 2 ? {} : { shadows: [0, 1], shadowSoftness: [1, 2], shadowBias: [0, 0.02], pointShadows: [1] };

const SURFACE_CASES: Readonly<Record<string, SurfaceCase>> = {
  "lambert grid": { model: "lambert" },
  "phong grid": { model: "phong" },
  "pbr grid": { model: "pbr" },
  "pbr grid, additive": { model: "pbr", additive: true },
  "pbr grid, many projectors": { model: "pbr", projectors: MANY_PROJECTORS },
  "pbr file mesh with surface rows": { model: "pbr", mesh: { uv: true, surface: true, emissive: true } },
  "pbr Material WGSL": { model: "pbr", custom: CUSTOM },
  "phong Material WGSL on a mesh": { model: "phong", mesh: { uv: true, surface: true, emissive: true }, custom: CUSTOM },
  "pbr mesh instances": { model: "pbr", mesh: { uv: true, surface: true, emissive: true }, instanced: INSTANCED },
  "every feature": {
    model: "pbr",
    maps: { albedo: true, roughness: true },
    pointColor: true,
    environment: true,
    environmentPrefiltered: true,
    ambientOcclusion: true,
    projectors: [{ cookie: true, occlusion: true }],
    mesh: { uv: true, surface: true, emissive: true },
    custom: CUSTOM,
  },
  "every feature, instanced": {
    model: "pbr",
    maps: { albedo: true, roughness: true },
    pointColor: true,
    environment: true,
    environmentPrefiltered: true,
    ambientOcclusion: true,
    projectors: [{ cookie: true, occlusion: true }],
    mesh: { uv: true, surface: true, emissive: true },
    custom: CUSTOM,
    instanced: INSTANCED,
  },
};

type InstancesCase = Omit<Parameters<typeof sceneInstancesWgsl>[0], "lightCount">;
const INSTANCES_CASES: Readonly<Record<string, InstancesCase>> = {
  "lambert boxes": { model: "lambert" },
  "phong boxes": { model: "phong" },
  "pbr boxes": { model: "pbr" },
  "pbr boxes, many projectors": { model: "pbr", projectors: MANY_PROJECTORS },
  "pbr billboards, spherical": { model: "pbr", billboard: true, sphericalPoints: true, pointColor: true },
  "pbr beams": { model: "pbr", beam: true },
  "every feature": {
    model: "pbr",
    pointColor: true,
    pointScale: { type: "f32" },
    pointOrient: true,
    environment: true,
    environmentPrefiltered: true,
    ambientOcclusion: true,
    projectors: [{ cookie: true, occlusion: true }],
  },
};

const surfaceText = (options: SurfaceCase, lightCount: number, withShadows: boolean): string =>
  String(sceneSurfaceWgsl({ ...options, lightCount, ...(withShadows ? casting(lightCount) : {}) }));
/** T1623b: the same module as a Render's lit draw emits it, walking the light table after `lightCount` blocks. */
const tableText = (options: SurfaceCase, lightCount: number, withShadows: boolean): string =>
  String(sceneSurfaceWgsl({ ...options, lightCount, lightGrid: true, ...(withShadows ? casting(lightCount) : {}) }));
const instancesText = (options: InstancesCase, lightCount: number, withShadows: boolean): string =>
  String(sceneInstancesWgsl({ ...options, lightCount, ...(withShadows ? casting(lightCount) : {}) }));

/** T1623b: every lit module the Surface generator emits for a Render's lit draw: the table's walk after `lightCount` blocks. */
function tableModules(lightCount: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const shadows of [false, true]) {
    for (const [name, options] of Object.entries(SURFACE_CASES)) out.push([`surface with the table: ${name}${shadows ? ", casting" : ""}`, tableText(options, lightCount, shadows)]);
  }
  return out;
}

/** Every lit module the TWO generators emit with NO table for a light count: each case, with and without casting lights. */
function litModules(lightCount: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const shadows of [false, true]) {
    for (const [name, options] of Object.entries(SURFACE_CASES)) out.push([`surface: ${name}${shadows ? ", casting" : ""}`, surfaceText(options, lightCount, shadows)]);
    for (const [name, options] of Object.entries(INSTANCES_CASES)) out.push([`instances: ${name}${shadows ? ", casting" : ""}`, instancesText(options, lightCount, shadows)]);
  }
  return out;
}

describe("B260: no lit fragment function chains more sources than the threshold", () => {
  it("counts a run the way the cause runs: unguarded blocks chain, a block under its own runtime test does not", () => {
    const block = (index: number, guarded: boolean): string =>
      `  {\n    let lightMeta = params.light${index}Meta;\n${guarded ? "    if (lightMeta.y != 0.0) {\n" : ""}    if (lightMeta.x < 0.5) { /* kind */ }\n    lit += a;\n    lit += b;\n${guarded ? "    }\n" : ""}  }\n`;
    const module = (blocks: string): string => `@fragment\nfn fs() -> vec4f {\n  var lit = vec3f(0.0);\n${blocks}  lit += env;\n  return vec4f(lit, 1.0);\n}`;
    expect(longestStraightRun(module([0, 1, 2].map((index) => block(index, false)).join("")))).toBe(3);
    expect(longestStraightRun(module([0, 1, 2].map((index) => block(index, true)).join("")))).toBe(1);
    /* A guarded light between two unguarded runs ends the first: 2 and 3, never 5 or 6. */
    expect(longestStraightRun(module([block(0, false), block(1, false), block(2, true), block(3, false), block(4, false), block(5, false)].join("")))).toBe(3);
    /* A test the compiler can fold is no guard: `if (true)` leaves the chain whole. */
    expect(longestStraightRun(module([0, 1, 2].map((index) => block(index, true).replace("lightMeta.y != 0.0", "true")).join("")))).toBe(3);
    /* A point shadow counts its taps in a `lit` of its own, in a loop: that is not the sum and ends no run. */
    const taps = "    {\n      var lit = 0.0;\n      for (var ox = -1; ox <= 1; ox = ox + 1) {\n        lit = lit + 1.0;\n      }\n    }\n    lit += a;";
    expect(longestStraightRun(module([0, 1, 2].map((index) => block(index, false).replace("    lit += a;", taps)).join("")))).toBe(3);
    /* A projector is a source like a light: one written without its tests would lengthen the lights' run. */
    const projector = (index: number, tested: boolean): string =>
      `  {\n    let pc = params.projector${index}Matrix * vec4f(input.world, 1.0);\n${tested ? "    if (pc.w > 1e-4) {\n" : ""}    lit += beam;\n${tested ? "    }\n" : ""}  }\n`;
    expect(longestStraightRun(module(`${block(0, false)}${block(1, false)}${projector(0, false)}${projector(1, false)}`))).toBe(4);
    expect(longestStraightRun(module(`${block(0, false)}${block(1, false)}${projector(0, true)}${projector(1, true)}`))).toBe(2);
  });

  it("counts a row of the light table as a source: a loop's turn is a merge, a row under a test of the loop's bound is one, rows in the open chain", () => {
    const row = (slot: string): string => `      {\n        let lightMeta = vec4f(1.0, 1.0, tone${slot}.w, 0.0);\n        lit += a;\n        lit += b;\n      }\n`;
    const module = (walk: string): string => `@fragment\nfn fs() -> vec4f {\n  var lit = vec3f(0.0);\n  {\n${walk}  }\n  lit += env;\n  return vec4f(lit, 1.0);\n}`;
    /* The walk's shape: two rows a turn, the second under a test of the bound. One source in the open at a time. */
    const twoATurn = `    for (var lightBase = from; lightBase < to; lightBase += 2u) {\n${row("0")}      if (lightBase + 1u < to) {\n${row("1")}      }\n    }\n`;
    expect(longestStraightRun(module(twoATurn))).toBe(1);
    /* Two loops one after the other do not chain either: each closes on a merge. */
    expect(longestStraightRun(module(`${twoATurn}${twoATurn}`))).toBe(1);
    /* The same two rows with the test taken off the second are two sources in one straight line of a turn. */
    expect(longestStraightRun(module(`    for (var lightBase = from; lightBase < to; lightBase += 2u) {\n${row("0")}${row("1")}    }\n`))).toBe(2);
    /* And rows unrolled in the open, nine of them at literal row numbers, are the chain B260 measured. */
    expect(longestStraightRun(module(Array.from({ length: 9 }, (_, index) => row(String(index))).join("")))).toBe(9);
    /* A test the compiler can fold is no test. */
    expect(longestStraightRun(module(`    for (var lightBase = from; lightBase < to; lightBase += 2u) {\n${row("0")}      if (true) {\n${row("1")}      }\n    }\n`))).toBe(2);
  });

  it("holds for every lit module that walks the light table, at 0 to 32 casting blocks: no two sources in one straight line", () => {
    const seen = new Map<string, number>();
    for (const lightCount of [0, 1, 2, LIGHT_GUARD_ABOVE, LIGHT_GUARD_ABOVE + 1, 4 * LIGHT_GUARD_ABOVE]) {
      for (const [name, text] of tableModules(lightCount)) {
        /* The module is the one the claim is about: it walks the table, and it shades rows the scan can see. */
        expect([name, lightCount, text.includes("lightTable"), (text.match(/let lightMeta = vec4f\(/g) ?? []).length]).toEqual([name, lightCount, true, 6]);
        seen.set(`${name}, ${lightCount} blocks`, longestStraightRun(text));
      }
    }
    /* Every block is guarded at every count beside the walk, every row of a turn after the first is under a test, and a projector under its two. */
    expect([...seen].filter(([, run]) => run !== 1)).toEqual([]);
    expect(seen.size).toBe(6 * 2 * Object.keys(SURFACE_CASES).length);
  });

  it("holds for every lit module with no table, of both generators, at 9, 32 and 64 lights, and either side of the threshold", () => {
    const counts = [1, LIGHT_GUARD_ABOVE, LIGHT_GUARD_ABOVE + 1, 4 * LIGHT_GUARD_ABOVE, 8 * LIGHT_GUARD_ABOVE];
    expect(MANY_PROJECTORS.length).toBeGreaterThan(LIGHT_GUARD_ABOVE);
    const over: string[] = [];
    let longestSeen = 0;
    for (const lightCount of counts) {
      for (const [name, text] of litModules(lightCount)) {
        const run = longestStraightRun(text);
        longestSeen = Math.max(longestSeen, run);
        if (run > LIGHT_GUARD_ABOVE) over.push(`${name}, ${lightCount} lights: ${run} sources in one straight chain`);
      }
    }
    expect(over).toEqual([]);
    /* The scanner sees the blocks at all: at the threshold the whole count is one run. */
    expect(longestSeen).toBe(LIGHT_GUARD_ABOVE);
  });

  it("keeps the threshold under the first count where a measured case leaves the straight line", () => {
    /* One casting point light and a Material WGSL: equal to the guarded text at 12 lights, a
       timer step slower at 16 (the document's table). Raising the threshold past 12 needs
       that table measured again, not a new number here. */
    expect(LIGHT_GUARD_ABOVE).toBeLessThanOrEqual(12);
  });
});

/**
 * The text main emitted on 2026-10-06 (7cc69950), before the guard, for each case at 0, 1, 2,
 * 5 and 8 lights, with and without casting lights: one SHA-256 over the ten texts.
 *
 * WHAT THESE PIN SINCE T1623b SLICE 3 (2026-10-06): the lit text of a module with NO light
 * table. When they were taken that was every Render's lit text at 8 lights or fewer. A
 * Render's lit Surface draw now walks its table and is another text (pinned by
 * `light-points.test.ts`'s fingerprints and held to one string by `light-rows.test.ts`). The
 * texts with no table that ship are the instances generator's (primitive instances, points
 * and beams still unroll a block for every Light in Single mode, until slice 7), a tile's
 * preview with its two stock lights, and the shadow matte. Slice 3 moved none of the
 * eighteen: a text with no table is byte for byte what it was.
 *
 * If a digest moves because the lit text was changed ON PURPOSE, the change moves the text of
 * shipped Renders: that is a decision, and it is made by replacing the digest in the same
 * commit that says so.
 *
 * §B255 (2026-10-06) made that decision for the six GRID surface cases, marked below: the
 * grid chunk's texture coordinate line changed (an axis divides by its cells, so a wrapped
 * one reaches 1 at its seam and a map goes once round). The mesh and instance cases carry
 * no grid chunk and did not move. Before: lambert grid 2717505ab16a6316, pbr Material WGSL
 * 5ba3e4b2fe94caa0, pbr grid 326c14a7a3a7a8d8, pbr grid additive 6eaba590ca5564d9, pbr grid
 * many projectors 2c0992f1f780d0a3, phong grid 33ea50e380739696.
 */
const TEXT_AT_AND_BELOW_THE_THRESHOLD: Readonly<Record<string, string>> = {
  "instances: every feature": "9469ec94d83d006b",
  "instances: lambert boxes": "b9f749509e1212f3",
  "instances: pbr beams": "dedf0a34a1924685",
  "instances: pbr billboards, spherical": "464b1308dc31f71e",
  "instances: pbr boxes": "8f1a800f9c626a17",
  "instances: pbr boxes, many projectors": "a90b1694c52863f5",
  "instances: phong boxes": "a6e35e45230851ad",
  "surface: every feature": "ebfc4f2f17792cf3",
  "surface: every feature, instanced": "08ac687490aa4d09",
  "surface: lambert grid": "42e77db29fe97b61", // §B255
  "surface: pbr Material WGSL": "dd94c30cf125247d", // §B255
  "surface: pbr file mesh with surface rows": "381f3a037e9c200e",
  "surface: pbr grid": "3862a064f9cad6eb", // §B255
  "surface: pbr grid, additive": "919ec18941e4d41b", // §B255
  "surface: pbr grid, many projectors": "434bfacef3d74cb1", // §B255
  "surface: pbr mesh instances": "17dac438da6a102a",
  "surface: phong Material WGSL on a mesh": "2d6c6b1825c09ebc",
  "surface: phong grid": "c2608dcc7fcfca2d", // §B255
};

describe("B260: with no light table, at and below the threshold the lit text is main's, byte for byte", () => {
  const COUNTS = [0, 1, 2, 5, 8];
  const digest = (texts: string[]): string => createHash("sha256").update(texts.join("\u0000")).digest("hex").slice(0, 16);

  it("emits no guard at 8 lights or fewer, in either generator, and guards every block at every count where the draw walks the table", () => {
    expect(COUNTS.every((count) => count <= LIGHT_GUARD_ABOVE)).toBe(true);
    for (const lightCount of COUNTS) {
      for (const [name, text] of litModules(lightCount)) expect([name, lightCount, text.includes("lightMeta.y != 0.0")]).toEqual([name, lightCount, false]);
      /* T1623b: beside the table's walk the blocks are the casting Lights', each under its guard from the first. */
      for (const [name, text] of tableModules(lightCount)) expect([name, lightCount, (text.match(/if \(lightMeta\.y != 0\.0\) \{/g) ?? []).length]).toEqual([name, lightCount, lightCount]);
    }
  });

  it("emits the same bytes main emitted, case by case", () => {
    const now: Record<string, string> = {};
    for (const [name, options] of Object.entries(SURFACE_CASES)) now[`surface: ${name}`] = digest(COUNTS.flatMap((count) => [surfaceText(options, count, false), surfaceText(options, count, true)]));
    for (const [name, options] of Object.entries(INSTANCES_CASES)) now[`instances: ${name}`] = digest(COUNTS.flatMap((count) => [instancesText(options, count, false), instancesText(options, count, true)]));
    expect(now).toEqual(TEXT_AT_AND_BELOW_THE_THRESHOLD);
  });
});
