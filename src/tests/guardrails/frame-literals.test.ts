import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Product code makes a frame through `frameFromClock` or `ZERO_FRAME`, never as an object
 * literal (T1554b, §V437).
 *
 * ## The property
 *
 * `FrameEvaluationInput` leaves six clock fields optional, and a reader that finds one absent
 * falls back to the timeline. So a frame built by hand that forgets the absolute clock still
 * compiles, and on a timeline that never wraps it reads exactly right — until the first lap,
 * where `abstime` snaps back with `time`. That is how the absolute clock was delivered one
 * site at a time (T461 → T468 → B97 → T489), and how seven hand-built frames came to exist
 * with seven different subsets of the fields (seam audit 2026-10-04, finding 4).
 *
 * The constructor is where the fallbacks now live, once, and what it returns
 * (`EvaluationFrame`) has every clock filled. The type cannot stop a literal on its own:
 * consumers take the wider `FrameEvaluationInput` so ~185 test files can hand them a
 * five-field frame. This gate is the other half — the rule, not the last incident's spelling.
 *
 * ## What counts as a frame literal
 *
 * An object literal that names `timeSeconds`, `frameIndex` and `randomSeed`: the timeline
 * reading and the two fields only a producer mints (the other clocks can be derived from a
 * frame; its index and seed cannot). It is allowed only as the argument of a
 * `frameFromClock(…)` call, and inside `frame.ts`, which holds the constructor. A literal that
 * SPREADS an existing frame and overrides a field (`{ ...frame, frameIndex: n }`, a time
 * probe's shift) derives from a complete frame and is not a new one; it names no seed and is
 * not matched. Neither is the shared uniform block (`time`, `frameIndex`, `randomSeed`), which
 * is what a frame becomes on the GPU side, not a frame.
 *
 * Scanned: every `.ts`/`.tsx` under `src/` except tests, test support (`src/tests/**`,
 * `*\/testing/**`, `test-support.ts`) — those build partial frames on purpose, which is the
 * reason the consumer type stays wide.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");

/** The module that holds the constructor; its own body is the one literal allowed. */
const CONSTRUCTOR_MODULE = "domain/types/frame.ts";
const CONSTRUCTOR = "frameFromClock";

function isTestPath(path: string): boolean {
  return (
    /\.test\.tsx?$/.test(path) ||
    /\.d\.ts$/.test(path) ||
    path.startsWith("tests/") ||
    path.includes("/testing/") ||
    /(^|\/)test-support\.tsx?$/.test(path)
  );
}

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !isTestPath(relative(SRC, full))) out.push(full);
  }
  return out;
}

function propertyNames(node: ts.ObjectLiteralExpression): Set<string> {
  const names = new Set<string>();
  for (const property of node.properties) {
    if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name !== undefined) {
      if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) names.add(property.name.text);
    }
  }
  return names;
}

/** Is this literal the argument of a `frameFromClock(…)` call? */
function isConstructorArgument(node: ts.ObjectLiteralExpression): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === CONSTRUCTOR
  );
}

/** `line: text` of every frame literal outside the constructor in one source text. */
function frameLiteralsIn(fileName: string, text: string): string[] {
  // Cheap prefilter: the AST parse is only paid for files that could hold one.
  if (!text.includes("timeSeconds") || !text.includes("frameIndex") || !text.includes("randomSeed")) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = propertyNames(node);
      if (names.has("timeSeconds") && names.has("frameIndex") && names.has("randomSeed") && !isConstructorArgument(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${line + 1}: ${node.getText(source).replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("a frame is made by its constructor, never by hand (T1554b, §V437)", () => {
  it("finds no frame object literal in product code outside frameFromClock", () => {
    const problems: string[] = [];
    for (const path of productFiles(SRC)) {
      const name = relative(SRC, path);
      if (name === CONSTRUCTOR_MODULE) continue;
      for (const hit of frameLiteralsIn(name, readFileSync(path, "utf8"))) problems.push(`src/${name}:${hit}`);
    }
    expect(
      problems,
      "Build the frame with frameFromClock({ …, fps }) (or use ZERO_FRAME) from @domain/types/frame.ts: " +
        "a hand-built frame that omits a clock falls back to the timeline and agrees with it until the first lap (§V437).",
    ).toEqual([]);
  });

  // The detector itself, on the cases it must tell apart: a gate that matches nothing passes.
  it("matches a hand-built frame and passes a constructor argument, a spread, and a non-frame", () => {
    const text = [
      'const a = { timeSeconds: 0, deltaSeconds: 0, frameIndex: 0, mode: "offline", randomSeed: 0 };',
      "const b = frameFromClock({ timeSeconds: 0, deltaSeconds: 0, frameIndex, mode: 'offline', randomSeed, fps: 60 });",
      "const c = { ...frame, frameIndex: 3 };",
      "const d = { time: frame.timeSeconds, randomSeed: frame.randomSeed };",
      "render({ frame: { timeSeconds: t, deltaSeconds: d, frameIndex, mode, randomSeed } });",
    ].join("\n");
    expect(frameLiteralsIn("probe.ts", text).map((hit) => hit.split(":")[0])).toEqual(["1", "5"]);
  });
});
