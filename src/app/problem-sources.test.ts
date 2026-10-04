import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { HEADLESS_ABSENT_PROBLEM_SOURCES } from "./problem-sources.ts";

/**
 * T1555b — EVERY HOOK THAT HANDS THE APP DIAGNOSTICS HAS A PROBLEMS REGISTRATION.
 *
 * The Problems list used to be a hand-written concatenation in `app.tsx`, with a second hand
 * list for Clear, and nothing checked that a hook's `diagnostics` reached either one. T586
 * is the receipt: a render take's own warnings had no channel at all until a row added one.
 * A hook that computes a diagnostic nobody renders shows the person nothing, which looks
 * exactly like having nothing to say (the §V803 class, B162/B193).
 *
 * So this file walks the source tree for exported `use*` hooks whose result carries
 * diagnostics, either a `diagnostics` field or the whole result being `RuntimeDiagnostic[]`.
 * It then requires each one to be called in `app.tsx` and read by a `useProblems`
 * registration, or exempted BY NAME with a reason. The headless server's registrations are
 * checked against the app's in the same pass: every app source is registered there too, or
 * named in `HEADLESS_ABSENT_PROBLEM_SOURCES` with the reason this process cannot have it.
 *
 * It reads the tree rather than importing what it checks, so `vitest related` cannot find
 * it. It is on `test:gates` (§V957).
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE = join(ROOT, "src");
const APP = join(SOURCE, "app/app.tsx");
const SERVE = join(SOURCE, "mcp/serve.ts");

/**
 * Hooks that return diagnostics and are deliberately not registered, each with the reason.
 * Checked in both directions: an entry that no longer names a diagnostics hook is stale.
 */
const NOT_A_PROBLEM_SOURCE: Readonly<Record<string, string>> = {};

/**
 * What the Problems list read, in order, before T1555b (`app.tsx` at 288478fd, lines
 * 1477–1521): the hand-written concatenation, as the expression each entry spread.
 * `gpuProblems` is the inline `gpu.unavailable` push that headed it. The registry must
 * keep these in this order. A NEW source may go anywhere without touching this list,
 * because the user-visible list for today's sources is what has to stay identical.
 */
const PROBLEMS_ORDER_BEFORE_T1555B = [
  "gpuProblems",
  "compile.diagnostics",
  "valueGraph.diagnostics",
  "media.diagnostics",
  "fileReferences.diagnostics",
  "screenCapture.diagnostics",
  "meshes.diagnostics",
  "nativeInputs.diagnostics",
  "phoneCameras.diagnostics",
  "nativeOutputs.diagnostics",
  "requirements",
  "osc.diagnostics",
  "laser.diagnostics",
  "vision.diagnostics",
  "rejection",
  "autosave.diagnostics",
  "project.diagnostics",
  "recovery.diagnostics",
  "frameLoop.diagnostics",
  "editing.diagnostics",
  "renderRange.diagnostics",
] as const;

/**
 * What the pre-T1555b `clearProblems` emptied, as the call it made: the seven accumulating
 * sources. Clear must empty exactly these, as long as no new accumulating source joins.
 */
const CLEARED_BEFORE_T1555B = [
  "setRejection(NO_DIAGNOSTICS)",
  "autosave.clearDiagnostics()",
  "media.clearDiagnostics()",
  "project.clearDiagnostics()",
  "recovery.clearDiagnostics()",
  "frameLoop.clearDiagnostics()",
  "editing.clearDiagnostics()",
] as const;

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

type Shape = "field" | "whole";

/** True when an object literal has a property named `diagnostics`. */
function hasDiagnosticsProperty(node: ts.Expression): boolean {
  const literal = ts.isParenthesizedExpression(node) ? node.expression : node;
  return (
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.some((property) => property.name !== undefined && property.name.getText() === "diagnostics")
  );
}

/** The `return` statements that belong to `body` itself, not to a function nested in it. */
function ownReturns(body: ts.Node): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) out.push(node);
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/** What a returned expression yields, looking through `useMemo(() => ...)`. */
function returnedExpressions(expression: ts.Expression): ts.Expression[] {
  if (
    ts.isCallExpression(expression) &&
    expression.expression.getText() === "useMemo" &&
    expression.arguments[0] !== undefined &&
    ts.isArrowFunction(expression.arguments[0])
  ) {
    const factory = expression.arguments[0];
    if (!ts.isBlock(factory.body)) return [factory.body];
    return ownReturns(factory.body).flatMap((statement) => (statement.expression ? [statement.expression] : []));
  }
  return [expression];
}

function typeMembersHaveDiagnostics(members: ts.NodeArray<ts.TypeElement>): boolean {
  return members.some((member) => member.name !== undefined && member.name.getText() === "diagnostics");
}

/** Whether a hook's result carries diagnostics, and how. */
function diagnosticsShape(hook: ts.FunctionDeclaration, file: ts.SourceFile): Shape | null {
  if (hook.type !== undefined) {
    const text = hook.type.getText();
    if (/^(readonly\s+)?RuntimeDiagnostic\[\]$|^ReadonlyArray<RuntimeDiagnostic>$/.test(text)) return "whole";
    if (ts.isTypeLiteralNode(hook.type)) return typeMembersHaveDiagnostics(hook.type.members) ? "field" : null;
    if (ts.isTypeReferenceNode(hook.type)) {
      const name = hook.type.typeName.getText();
      for (const statement of file.statements) {
        if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
          return typeMembersHaveDiagnostics(statement.members) ? "field" : null;
        }
        if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name && ts.isTypeLiteralNode(statement.type)) {
          return typeMembersHaveDiagnostics(statement.type.members) ? "field" : null;
        }
      }
    }
    return null;
  }
  if (hook.body === undefined) return null;
  const returned = ownReturns(hook.body).flatMap((statement) =>
    statement.expression ? returnedExpressions(statement.expression) : [],
  );
  return returned.some(hasDiagnosticsProperty) ? "field" : null;
}

interface DiagnosticsHook {
  readonly name: string;
  readonly file: string;
  readonly shape: Shape;
}

/** Every exported `use*` hook under `src/` whose result carries diagnostics. */
function diagnosticsHooks(): DiagnosticsHook[] {
  const out: DiagnosticsHook[] = [];
  for (const path of walk(SOURCE)) {
    const text = readFileSync(path, "utf8");
    // A cheap prefilter. "diagnostics", not "RuntimeDiagnostic": a hook can return a
    // `diagnostics` field typed in another module without naming the type itself.
    if (!/\bdiagnostics\b/.test(text) || !/export function use[A-Z]/.test(text)) continue;
    const file = parse(path);
    for (const statement of file.statements) {
      if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
      if (!/^use[A-Z]/.test(statement.name.text)) continue;
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const shape = diagnosticsShape(statement, file);
      if (shape !== null) out.push({ name: statement.name.text, file: relative(ROOT, path), shape });
    }
  }
  return out;
}

/** `const <binding> = useHook(...)` in a file, by hook name. A destructured binding maps to null. */
function hookBindings(file: ts.SourceFile): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      /^use[A-Z]/.test(node.initializer.expression.text)
    ) {
      out.set(node.initializer.expression.text, ts.isIdentifier(node.name) ? node.name.text : null);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

interface Registration {
  readonly id: string;
  /** The expression `read` returns, as written. */
  readonly reads: string;
  /** The expression `clear` evaluates, as written, or null for a derived source. */
  readonly clears: string | null;
}

function arrowBody(initializer: ts.Expression | undefined, where: string): string {
  if (initializer === undefined || !ts.isArrowFunction(initializer) || ts.isBlock(initializer.body)) {
    throw new Error(`${where}: expected an expression-bodied arrow, which is what this gate can read`);
  }
  return initializer.body.getText();
}

function registrations(array: ts.ArrayLiteralExpression, where: string): Registration[] {
  return array.elements.map((element, index) => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error(`${where}[${index}] is not an object literal`);
    const field = (name: string) =>
      element.properties.find((property) => property.name?.getText() === name) as ts.PropertyAssignment | undefined;
    const id = field("id")?.initializer;
    if (id === undefined || !ts.isStringLiteral(id)) throw new Error(`${where}[${index}] has no string-literal id`);
    const clear = field("clear");
    return {
      id: id.text,
      reads: arrowBody(field("read")?.initializer, `${where} "${id.text}".read`),
      clears: clear === undefined ? null : arrowBody(clear.initializer, `${where} "${id.text}".clear`),
    };
  });
}

/** The array literal handed to the app's one `useProblems(...)` call. */
function appRegistrations(file: ts.SourceFile): Registration[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText() === "useProblems") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(calls, "app.tsx must call useProblems exactly once").toHaveLength(1);
  const array = calls[0]?.arguments[0];
  if (array === undefined || !ts.isArrayLiteralExpression(array)) {
    throw new Error("useProblems' first argument must be an array literal of registrations");
  }
  return registrations(array, "app.tsx useProblems");
}

/** The headless server's `const problemSources = [...]`. */
function headlessRegistrations(file: ts.SourceFile): Registration[] {
  let found: ts.ArrayLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "problemSources" &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found === null) throw new Error("mcp/serve.ts has no `const problemSources = [...]`");
  return registrations(found, "serve.ts problemSources");
}

const app = parse(APP);
const hooks = diagnosticsHooks();const appSources = appRegistrations(app);

describe("T1555b — the Problems surface is a registry, and every diagnostics hook is on it", () => {
  it("finds the hooks it guards (a detector that finds nothing passes everything)", () => {
    const names = hooks.map((hook) => hook.name);
    // One of each detection route: an interface field, an inferred `return { diagnostics }`,
    // a `useMemo` factory, and a whole-array result.
    expect(names).toEqual(expect.arrayContaining(["useAutosave", "useNativeInputs", "useOscBridge", "useRequirementDiagnostics"]));
  });

  it("every hook returning diagnostics is called in app.tsx and read by a registration", () => {
    const bindings = hookBindings(app);
    const reads = new Set(appSources.map((source) => source.reads));
    const missing: string[] = [];
    for (const hook of hooks) {
      if (NOT_A_PROBLEM_SOURCE[hook.name] !== undefined) continue;
      if (!bindings.has(hook.name)) {
        missing.push(`${hook.name} (${hook.file}) returns diagnostics and app.tsx never calls it`);
        continue;
      }
      const binding = bindings.get(hook.name);
      if (binding === null || binding === undefined) {
        missing.push(`${hook.name}: app.tsx destructures its result, so this gate cannot see where its diagnostics go`);
        continue;
      }
      const expected = hook.shape === "whole" ? binding : `${binding}.diagnostics`;
      if (!reads.has(expected)) {
        missing.push(`${hook.name} (${hook.file}): no useProblems registration reads \`${expected}\``);
      }
    }
    expect(missing, "register each in app.tsx's useProblems list, or exempt it by name with a reason").toEqual([]);
  });

  it("keeps every exemption honest: it must still name a hook that returns diagnostics", () => {
    const names = new Set(hooks.map((hook) => hook.name));
    for (const [name, reason] of Object.entries(NOT_A_PROBLEM_SOURCE)) {
      expect(reason.length, `${name}'s exemption has no reason`).toBeGreaterThan(20);
      expect(names.has(name), `${name} is exempted but no longer returns diagnostics`).toBe(true);
    }
  });

  it("names every source once", () => {
    const ids = appSources.map((source) => source.id);
    expect(new Set(ids).size, `duplicate ids in ${ids.join(", ")}`).toBe(ids.length);
  });

  it("keeps today's sources in the order the hand-written list had them", () => {
    const before = new Set<string>(PROBLEMS_ORDER_BEFORE_T1555B);
    expect(appSources.map((source) => source.reads).filter((read) => before.has(read))).toEqual([
      ...PROBLEMS_ORDER_BEFORE_T1555B,
    ]);
  });

  it("clears exactly the seven sources the hand-written Clear emptied", () => {
    const clears = appSources.flatMap((source) => (source.clears === null ? [] : [source.clears]));
    expect([...clears].sort()).toEqual([...CLEARED_BEFORE_T1555B].sort());
    // And each clear empties the source it sits on, not a neighbour's.
    for (const source of appSources) {
      if (source.clears === null) continue;
      const owner = source.clears.split(".")[0];
      expect(source.clears === "setRejection(NO_DIAGNOSTICS)" ? "rejection" : `${owner}.diagnostics`).toBe(source.reads);
    }
  });

  it("the headless server registers each app source or says why it cannot have it", () => {
    const appIds = appSources.map((source) => source.id);
    const headlessIds = headlessRegistrations(parse(SERVE)).map((source) => source.id);
    const absent = Object.keys(HEADLESS_ABSENT_PROBLEM_SOURCES);
    const unaccounted = appIds.filter((id) => !headlessIds.includes(id) && !absent.includes(id));
    expect(unaccounted, "register these in serve.ts or name them in HEADLESS_ABSENT_PROBLEM_SOURCES").toEqual([]);
    expect(absent.filter((id) => headlessIds.includes(id)), "named absent AND registered headless").toEqual([]);
    expect(absent.filter((id) => !appIds.includes(id)), "absent entries the app does not register").toEqual([]);
    expect(headlessIds.filter((id) => !appIds.includes(id)), "headless sources the app does not have").toEqual([]);
    for (const [id, reason] of Object.entries(HEADLESS_ABSENT_PROBLEM_SOURCES)) {
      expect(reason.length, `${id}'s absence has no reason`).toBeGreaterThan(20);
    }
  });
});
