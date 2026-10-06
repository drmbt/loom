import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { NodeId } from "../domain/types/ids.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";
import { authoredPosition } from "../runtime/backend/wgsl-source-map.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";

/**
 * B263 — AN INTEGER DIVIDE OR REMAINDER OF THE HIGH HALF OF A 32-BIT VALUE, BY A CONSTANT.
 *
 * On Apple GPUs that one shape returns a wrong value: `(h >> 16u) % 97u` gave 63993 where the
 * CPU says 9, in a compute kernel and in a fragment shader, with the shift itself and every
 * mask around it correct. The WGSL is valid, Tint's Metal is right and Apple's own front end
 * emits a correct 16-bit divide; the driver's backend gets it wrong
 * (`docs/apple-gpu-divide-high-half-2026-10-06.md`). It is the line an author writes to draw
 * a lot from a hash, and it disagrees with the same line on the CPU without a word.
 *
 * So the compiler READS THE TEXT of every pass and says so, by the author's node and line.
 * It rewrites nothing. What it flags is pinned by a table measured on the device
 * (`wgsl-high-half.cases.ts`): every line there that the device gets wrong and whose text
 * shows it is flagged, and no line the device gets right is.
 *
 * THE SHAPE, as text, inside one function:
 *
 *   a `/` or `%` whose LEFT operand is a bare high half
 *     - `(x >> 16u)`, shifts that add to 16, `(x / 65536u)`, a vector shifted by `vec2u(16u)`,
 *       any of them inside `u32(…)` or `i32(…)`,
 *     - or a `let` or `const` name bound to one, or to another such name;
 *   and whose RIGHT operand is an integer constant that is not a power of two
 *     - a literal, `vec2u(97u)`, or a `let` or `const` name bound to a literal.
 *
 * Anything between the shift and the divide (a mask, an add, a multiply, a call) is not the
 * shape, and is right on the device.
 *
 * WHAT IT CANNOT SEE, being a reader of text and not a compiler: a high half that arrives as
 * a function's result or argument, a `var`, and a divisor the compiler folds to a constant by
 * itself. Silence here is not a measurement; the canary under `tools/` is.
 */
export interface HighHalfDivision {
  /** Where the operator is in the text, 1-based, as a device counts. */
  readonly line: number;
  readonly column: number;
  /** The division as written: the left operand, the operator and the constant. */
  readonly text: string;
}

const NONE: ReadonlyArray<HighHalfDivision> = Object.freeze([]);
/** Without a right shift or a 65536 there is no high half to divide: most texts stop here. */
const MAY_HOLD = />>|65536|0[xX]10000/;
/** Distinct pass texts remembered. A plan holds a few hundred; a shader editor's keystrokes run into the cap. */
const REMEMBERED = 512;
const answers = new Map<string, ReadonlyArray<HighHalfDivision>>();

/**
 * Every division of the shape in a WGSL text: a whole module, one function, or a bare
 * expression (a Group predicate). Remembered by the text, because a compile runs every frame
 * and a pass's text is the same string object frame after frame.
 */
export function highHalfDivisions(wgsl: string): ReadonlyArray<HighHalfDivision> {
  const hit = answers.get(wgsl);
  if (hit !== undefined) return hit;
  const found = MAY_HOLD.test(wgsl) ? scan(wgsl) : NONE;
  answers.set(wgsl, found);
  if (answers.size > REMEMBERED) {
    const oldest = answers.keys().next();
    if (oldest.done !== true) answers.delete(oldest.value);
  }
  return found;
}

/** Comments and quoted runs as spaces, newlines kept: every index and every line still addresses the original. */
function masked(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) if (out[index] !== "\n") out[index] = " ";
  };
  let at = 0;
  while (at < source.length) {
    const two = source.startsWith("//", at) ? "//" : source.startsWith("/*", at) ? "/*" : "";
    if (two === "//") {
      const end = source.indexOf("\n", at);
      blank(at, end < 0 ? source.length : end);
      at = end < 0 ? source.length : end;
    } else if (two === "/*") {
      /* WGSL block comments nest. */
      let depth = 1;
      let end = at + 2;
      while (end < source.length && depth > 0) {
        if (source.startsWith("/*", end)) {
          depth += 1;
          end += 2;
        } else if (source.startsWith("*/", end)) {
          depth -= 1;
          end += 2;
        } else end += 1;
      }
      blank(at, end);
      at = end;
    } else if (source[at] === '"') {
      const end = source.indexOf('"', at + 1);
      const line = source.indexOf("\n", at);
      const stop = end < 0 || (line >= 0 && line < end) ? at + 1 : end + 1;
      blank(at, stop);
      at = stop;
    } else at += 1;
  }
  return out.join("");
}

const isSpace = (char: string | undefined): boolean => char === " " || char === "\n" || char === "\t" || char === "\r";
const isWord = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/.test(char);

/** Index of the bracket that closes the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Index of the bracket that opens the one closed at `close`, not before `floor`, or -1. */
function opening(text: string, close: number, floor: number): number {
  let depth = 0;
  for (let index = close; index >= floor; index -= 1) {
    const char = text[index];
    if (char === ")" || char === "]") depth += 1;
    else if (char === "(" || char === "[") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The bodies of the functions a text declares, as index ranges; the whole text when it declares none. */
function functionBodies(text: string): Array<readonly [number, number]> {
  const bodies: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(/\bfn\s+[A-Za-z_]\w*\s*\(/g)) {
    const parameters = closing(text, match.index + match[0].length - 1);
    const open = parameters < 0 ? -1 : text.indexOf("{", parameters);
    const close = open < 0 ? -1 : closing(text, open);
    if (close > 0) bodies.push([open + 1, close]);
  }
  return bodies.length === 0 ? [[0, text.length]] : bodies;
}

const INTEGER = String.raw`(0[xX][0-9a-fA-F]+|\d+)[ui]?(?![\w.])`;
const VECTOR = String.raw`vec[234](?:[ui]|<\s*[ui]32\s*>)\(\s*`;
const WHOLE_INTEGER = new RegExp(`^${INTEGER}$`);
const WHOLE_VECTOR = new RegExp(`^${VECTOR}${INTEGER}\\s*\\)$`);
const LEADING_INTEGER = new RegExp(`^(\\(?\\s*)${INTEGER}`);
const LEADING_VECTOR = new RegExp(`^${VECTOR}${INTEGER}\\s*\\)`);
const KEYWORDS: ReadonlySet<string> = new Set(["return", "if", "else", "while", "switch", "case", "let", "var", "const", "loop"]);

/** What a name is known to be, inside one function. */
interface Bound {
  /** A `let` or `const` bound to an integer literal. */
  int?: number;
  /** How far right the value was shifted, in all: 16 is the high half. */
  shift?: number;
}

/** An integer literal's value, plain or as a vector of one value. */
function literal(text: string): number | undefined {
  const match = WHOLE_INTEGER.exec(text) ?? WHOLE_VECTOR.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** Binary operators at bracket depth 0, as [index, text]; a two-character operator counts once. */
function topLevelOperators(expression: string): Array<readonly [number, string]> {
  const found: Array<readonly [number, string]> = [];
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index] as string;
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && "+-*/%&|^<>=!".includes(char)) {
      const pair = expression.slice(index, index + 2);
      const two = [">>", "<<", "&&", "||", "==", "!=", "<=", ">="].includes(pair);
      found.push([index, two ? pair : char]);
      if (two) index += 1;
    }
  }
  return found;
}

/** `(…)`, `u32(…)` and `i32(…)` round a whole expression, taken off. */
function unwrapped(expression: string): string {
  let text = expression.trim();
  for (;;) {
    const cast = /^(?:u32|i32)\s*(?=\()/.exec(text);
    const open = cast === null ? 0 : cast[0].length;
    if (text[open] !== "(" || closing(text, open) !== text.length - 1) return text;
    text = text.slice(open + 1, -1).trim();
  }
}

/**
 * How far right an expression shifts a value, in all, when that is all it does: `x >> 16u` is
 * 16, `(x >> 8u) >> 8u` is 16, `x / 65536u` is 16, a name bound to one of them is its own.
 * Undefined for anything else.
 */
function shiftOf(expression: string, names: ReadonlyMap<string, Bound>): number | undefined {
  const text = unwrapped(expression);
  if (/^[A-Za-z_]\w*$/.test(text)) return names.get(text)?.shift;
  const operators = topLevelOperators(text);
  const last = operators[operators.length - 1];
  if (last === undefined) return undefined;
  const [index, operator] = last;
  const left = text.slice(0, index);
  const right = literal(text.slice(index + operator.length).trim());
  if (right === undefined) return undefined;
  /* WGSL lets a shift stand beside no other binary operator without brackets, so a `>>` at depth 0 is the whole expression. */
  if (operator === ">>") return right + (shiftOf(left, names) ?? 0);
  if (operator === "/" && right === 65536 && operators.length === 1) return 16 + (shiftOf(left, names) ?? 0);
  return undefined;
}

/** The left operand of the operator at `at`: a bracketed expression, or a name. Undefined for anything that cannot be a bare high half. */
function leftOperand(text: string, at: number, floor: number): { readonly start: number; readonly expression: string } | undefined {
  let end = at - 1;
  while (end >= floor && isSpace(text[end])) end -= 1;
  if (end < floor) return undefined;
  if (text[end] === ")") {
    const open = opening(text, end, floor);
    if (open < 0) return undefined;
    let start = open;
    while (start > floor && isWord(text[start - 1])) start -= 1;
    const callee = text.slice(start, open);
    /* A generic constructor (`vec2<u32>(…)`) or any call but an integer cast is a value of its own. */
    if (text[open - 1] === ">") return undefined;
    if (callee !== "" && !KEYWORDS.has(callee) && callee !== "u32" && callee !== "i32") return undefined;
    return { start: KEYWORDS.has(callee) ? open : start, expression: text.slice(KEYWORDS.has(callee) ? open : start, end + 1) };
  }
  if (!isWord(text[end])) return undefined;
  let start = end;
  while (start > floor && isWord(text[start - 1])) start -= 1;
  /* A component of a vector name (`m.x`) is the name's; a member of anything else (`p.id`) is its own value. */
  if (text[start - 1] === ".") {
    let base = start - 1;
    while (base > floor && isWord(text[base - 1])) base -= 1;
    if (base === start - 1 || text[base - 1] === ".") return undefined;
    return { start: base, expression: text.slice(base, start - 1) };
  }
  return /^\d/.test(text.slice(start, end + 1)) ? undefined : { start, expression: text.slice(start, end + 1) };
}

/** The integer constant that starts at `from`, and where it ends. */
function constantAt(text: string, from: number, names: ReadonlyMap<string, Bound>): { readonly value: number; readonly end: number } | undefined {
  let at = from;
  while (isSpace(text[at])) at += 1;
  const rest = text.slice(at, at + 96);
  const vector = LEADING_VECTOR.exec(rest);
  if (vector !== null) return { value: Number(vector[1]), end: at + vector[0].length };
  const plain = LEADING_INTEGER.exec(rest);
  if (plain !== null) {
    if ((plain[1] as string).length === 0) return { value: Number(plain[2]), end: at + plain[0].length };
    /* A literal in brackets of its own is the literal; a bracket that holds more is an expression, and not read. */
    const close = /^\s*\)/.exec(rest.slice(plain[0].length));
    return close === null ? undefined : { value: Number(plain[2]), end: at + plain[0].length + close[0].length };
  }
  const name = /^([A-Za-z_]\w*)(?![\w.([])/.exec(rest);
  const value = name === null ? undefined : names.get(name[1] as string)?.int;
  return value === undefined || name === null ? undefined : { value, end: at + name[0].length };
}

function scan(source: string): ReadonlyArray<HighHalfDivision> {
  const text = masked(source);
  const found: HighHalfDivision[] = [];
  /* Module constants are in scope of every function. */
  const shared = new Map<string, Bound>();
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*(?::[^=;]+)?=([^;]*);/g)) {
    const value = literal((match[2] as string).trim());
    if (value !== undefined) shared.set(match[1] as string, { int: value });
  }
  for (const [from, to] of functionBodies(text)) {
    const body = text.slice(from, to);
    const names = new Map<string, Bound>(shared);
    /* In order, so a name bound to a name bound to a shift is one too. */
    for (const match of body.matchAll(/\b(?:let|const)\s+([A-Za-z_]\w*)\s*(?::[^=;]+)?=([^;]*);/g)) {
      const initial = (match[2] as string).trim();
      const value = literal(initial);
      const shift = shiftOf(initial, names);
      names.set(match[1] as string, { ...(value === undefined ? {} : { int: value }), ...(shift === undefined ? {} : { shift }) });
    }
    for (let at = 0; at < body.length; at += 1) {
      const operator = body[at];
      if ((operator !== "/" && operator !== "%") || body[at + 1] === "=") continue;
      const divisor = constantAt(body, at + 1, names);
      /* A power of two is a shift, and right. */
      if (divisor === undefined || divisor.value < 2 || (divisor.value & (divisor.value - 1)) === 0) continue;
      const dividend = leftOperand(body, at, 0);
      if (dividend === undefined || shiftOf(dividend.expression, names) !== 16) continue;
      /* `3u * m % 97u` divides the product, and `~m % 97u` the complement: neither is the bare half. */
      let before = dividend.start - 1;
      while (before >= 0 && isSpace(body[before])) before -= 1;
      if (before >= 0 && "*/%~!".includes(body[before] as string)) continue;
      const index = from + at;
      const line = source.slice(0, index).split("\n").length;
      found.push({
        line,
        column: index - source.lastIndexOf("\n", index - 1),
        text: source.slice(from + dividend.start, from + divisor.end).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return found.length === 0 ? NONE : Object.freeze(found);
}

const WHAT_TO_WRITE =
  'For a lot in 0..n-1 from a hash, add "// @use lot" and write hashLot(h, n). Otherwise take the bits with extractBits(x, 16u, 16u) before dividing; both are right on every GPU.';

/**
 * The warnings for a plan's passes: one per division an author wrote, on the author's node,
 * parameter and line (a Material · WGSL's code is drawn in the Render's pass, a kernel's
 * inside eighty generated lines; the pass's source map says where each sits). A division in
 * text nobody wrote is named on the pass's own node.
 */
export function highHalfDivideWarnings(passes: ReadonlyArray<PassDescriptor>): RuntimeDiagnostic[] {
  const out: RuntimeDiagnostic[] = [];
  const said = new Set<string>();
  for (const pass of passes) {
    if (pass.kind !== "effect" && pass.kind !== "draw" && pass.kind !== "dispatch") continue;
    for (const hit of highHalfDivisions(pass.shader)) {
      const authored = pass.sourceMap === undefined ? undefined : authoredPosition(pass.sourceMap, hit);
      const nodeId = authored?.nodeId ?? pass.nodeId;
      const where = authored === undefined ? "in the shader this node generates" : `in its ${authored.parameter}, line ${authored.line}`;
      /* One Material · WGSL is drawn in many passes: say its line once. */
      const key = `${nodeId ?? pass.id}\u0000${where}\u0000${hit.text}`;
      if (said.has(key)) continue;
      said.add(key);
      out.push(
        compilerDiagnostic(
          "warning",
          CompilerDiagnosticCode.wgslHighHalfDivide,
          `Node "${nodeId ?? pass.id}": \`${hit.text}\` ${where} divides the high half of a 32-bit value by a constant. The WGSL is valid, and Apple GPUs return a wrong value for it.`,
          { ...(nodeId === undefined ? {} : { nodeId: nodeId as NodeId }), suggestion: WHAT_TO_WRITE },
        ),
      );
    }
  }
  return out;
}
