import { describe, expect, it } from "vitest";

import { CompilerDiagnosticCode } from "../compiler/diagnostics.ts";
import { highHalfDivisions } from "../compiler/wgsl-high-half.ts";
import { sceneInstancesWgsl, sceneSurfaceWgsl } from "../nodes/shaders/scene-render.wgsl.ts";
import { SHARED_WGSL_MODULES } from "../nodes/shaders/shared-modules.ts";
import { listExamples, listProjectDocuments, listStarterComponentFiles, type ExampleFile } from "./catalogue.ts";
import { runExample } from "./runner.ts";

/**
 * B263 — NOTHING THAT SHIPS DIVIDES THE HIGH HALF OF A 32-BIT VALUE BY A CONSTANT.
 *
 * `(h >> 16u) % 97u` is valid WGSL and wrong on Apple GPUs
 * (`docs/apple-gpu-divide-high-half-2026-10-06.md`). An author who writes it is told by the
 * compiler (`compiler/wgsl-high-half.ts`). This gate is for the text nobody is told about:
 * the stock shaders, the generators' output, and the WGSL inside every shipped document.
 * A stock node with the shape would draw a different lot on a Mac than its CPU twin says,
 * with every test on another machine green.
 *
 * Three walks, none hand-listed:
 *
 *  1. every shipped example, compiled: the compiler's own reader over EVERY PASS of the plan,
 *     which is every generator's output for the options the examples use, with the authored
 *     code inside it;
 *  2. every string anywhere in every shipped document (examples, starter components, project
 *     documents, which are not compiled here), read as WGSL: a kernel, a material, a Group
 *     predicate, wherever a document keeps one;
 *  3. the shared modules an author pulls in by name, and the Render's two lit generators
 *     with their features on.
 *
 * It lives beside the documents because it reads the document set, and is on `test:gates`
 * for the same reason: no file's own tests would run it.
 */

const SHIPPED: ReadonlyArray<readonly [string, ExampleFile]> = [
  ...listExamples().map((file) => [`examples/${file.fileName}`, file] as const),
  ...listStarterComponentFiles().map((file) => [`examples/components/${file.fileName}`, file] as const),
  ...listProjectDocuments().map((file) => [`projects/${file.fileName}`, file] as const),
];

/** Every string a JSON value holds, at any depth. */
function stringsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

const hasShift = (text: string): boolean => />>\s*\d/.test(text);

describe("B263: no shipped text divides a high half by a constant", () => {
  it("the compiler finds none in any pass of any shipped example", () => {
    const flagged: string[] = [];
    let passes = 0;
    let withShift = 0;
    for (const file of listExamples()) {
      const result = runExample(file);
      for (const pass of result.read?.passes ?? []) {
        if (pass.kind !== "effect" && pass.kind !== "draw" && pass.kind !== "dispatch") continue;
        passes += 1;
        if (hasShift(pass.shader)) withShift += 1;
      }
      for (const diagnostic of result.plan?.diagnostics ?? []) {
        if (diagnostic.code === CompilerDiagnosticCode.wgslHighHalfDivide) flagged.push(`${file.fileName}: ${diagnostic.message}`);
      }
    }
    expect(flagged).toEqual([]);
    /* Not vacuous: thousands of passes were read, and hundreds of them shift a value right. */
    expect(passes).toBeGreaterThan(1000);
    expect(withShift).toBeGreaterThan(100);
  });

  it("no string of any shipped document holds one", () => {
    const flagged: string[] = [];
    let shifting = 0;
    for (const [path, file] of SHIPPED) {
      for (const text of stringsOf(JSON.parse(file.text))) {
        if (hasShift(text)) shifting += 1;
        for (const hit of highHalfDivisions(text)) flagged.push(`${path}: \`${hit.text}\``);
      }
    }
    expect(flagged).toEqual([]);
    expect(SHIPPED.length).toBeGreaterThan(100);
    /* Not vacuous: shipped code does shift by sixteen (the xor fold of a hash), and is read. */
    expect(shifting).toBeGreaterThan(20);
  });

  it("would find one: the same walk over a shipped kernel with the consumer's line added", () => {
    /* The first shipped string that folds a hash by `x ^ (x >> 16u)`, with a lot drawn from the half behind it. */
    const real = SHIPPED.flatMap(([, file]) => stringsOf(JSON.parse(file.text))).find((text) => /\^ ?\(\w+ ?>> ?16u\)/.test(text) && /\bfn\s+\w+\s*\(/.test(text));
    expect(real).toBeDefined();
    const planted = (real as string).replace(/\bfn\s+(\w+)\s*\(([^)]*)\)([^{]*)\{/, (whole) => `${whole}\n  let b263Half = 7u >> 16u;\n  let b263Lot = b263Half % 97u;\n`);
    expect(planted).not.toBe(real);
    expect(highHalfDivisions(real as string)).toEqual([]);
    expect(highHalfDivisions(planted).map((hit) => hit.text)).toEqual(["b263Half % 97u"]);
  });

  it("the shared modules and the Render's lit generators hold none", () => {
    const flagged: string[] = [];
    for (const [name, module] of Object.entries(SHARED_WGSL_MODULES)) {
      for (const hit of highHalfDivisions(module.source)) flagged.push(`// @use ${name}: \`${hit.text}\``);
    }
    const lit = { model: "pbr", lightCount: 12, shadows: [0, 1], shadowSoftness: [1, 2], pointShadows: [1], environment: true, ambientOcclusion: true, projectors: [{ cookie: true, occlusion: true }] } as const;
    const texts: Array<[string, string]> = [
      ["surface generator", String(sceneSurfaceWgsl({ ...lit, maps: { albedo: true, roughness: true }, mesh: { uv: true, surface: true, emissive: true } }))],
      ["instances generator", String(sceneInstancesWgsl({ ...lit, pointColor: true, pointScale: { type: "f32" }, pointOrient: true }))],
      ["instances generator, billboards", String(sceneInstancesWgsl({ ...lit, billboard: true, sphericalPoints: true }))],
    ];
    for (const [name, text] of texts) for (const hit of highHalfDivisions(text)) flagged.push(`${name}: \`${hit.text}\``);
    expect(flagged).toEqual([]);
    /* The hash module is read, not skipped: it shifts, and its shifts are not the shape. */
    expect(hasShift(SHARED_WGSL_MODULES["hash"]?.source ?? "")).toBe(true);
    expect(hasShift(SHARED_WGSL_MODULES["lot"]?.source ?? "")).toBe(true);
  });
});
