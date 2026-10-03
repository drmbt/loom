/**
 * T1523b — WHERE AN AUTHOR'S TEXT SITS INSIDE A PASS'S GENERATED WGSL.
 *
 * The device's compiler reports `line:col` in the module it was handed, and a node rarely
 * hands it the author's text alone: a Custom WGSL puts its `// @use` modules in front, a
 * point kernel wraps the body in eighty lines of generated structs and accessors and hoists
 * its `struct Params` above them. A position read off the device is therefore a position in
 * text nobody wrote — line 84 where the author's line is 3.
 *
 * So the EMITTER, which is the only party that knows where it put the author's bytes, says
 * so on the pass (`sourceMap`): a list of spans, each one run of a code parameter's text
 * copied verbatim into the module. Nothing re-reads the generated text to guess.
 *
 * A span maps lines one-for-one. Only its FIRST line can be shifted sideways (the author's
 * text may start mid-line, e.g. inside `return (…);`), so a column is translated on that
 * line and kept on every other. A position inside no span is generated code, and says so
 * rather than being pinned to an author line it is not on.
 *
 * Plain data on purpose: the plan crosses `readExecutionPlan`, so the map is read and
 * validated there like every other descriptor field, and it never reaches a structure key
 * — it is derived from the same text the `shader` already carries.
 */

/** A 1-based position in a text, as the device's compiler counts. */
export interface WgslPosition {
  readonly line: number;
  readonly column: number;
}

/** One run of a code parameter's text, copied verbatim into a pass's WGSL. */
export interface AuthoredSpan {
  /** The code parameter the text came from — `source`, `kernel`, `group`, `spawn`. */
  readonly parameter: string;
  /** Where the run starts in the pass's WGSL. */
  readonly at: WgslPosition;
  /** Where that same character is in the parameter's text. */
  readonly from: WgslPosition;
  /** How many lines the run covers (at least 1). */
  readonly lines: number;
  /**
   * T1535b: the node whose parameter it is, when that is not the pass's own node — a
   * Material · WGSL's code is drawn inside the Scene node's pass, and its error belongs on
   * the material. Absent: the pass's node.
   */
  readonly nodeId?: string;
}

export type WgslSourceMap = readonly AuthoredSpan[];

/** A device position translated into the author's text. */
export interface AuthoredPosition extends WgslPosition {
  readonly parameter: string;
  /** T1535b: the span's node, when it names one other than the pass's. */
  readonly nodeId?: string;
}

/** Bounded like every per-text memo in the emitters: a typed-per-keystroke source must not leak. */
const ADVANCE_CACHE_LIMIT = 256;
const shapeByText = new Map<string, { readonly newlines: number; readonly tail: number }>();

/**
 * How many newlines a text holds and how long its last line is. Memoised by the text: §T259
 * compiles every frame, the texts are the same string objects frame after frame (the store's
 * value, the `wgsl` tag's cached output), and a kernel is kilobytes.
 */
function shapeOf(text: string): { readonly newlines: number; readonly tail: number } {
  const hit = shapeByText.get(text);
  if (hit !== undefined) return hit;
  let newlines = 0;
  let last = -1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines += 1;
    last = index;
  }
  const shape = { newlines, tail: text.length - last - 1 };
  shapeByText.set(text, shape);
  if (shapeByText.size > ADVANCE_CACHE_LIMIT) {
    const oldest = shapeByText.keys().next();
    if (oldest.done !== true) shapeByText.delete(oldest.value);
  }
  return shape;
}

/** The position just past `text`, when `text` is written starting at `at`. */
export function advance(at: WgslPosition, text: string): WgslPosition {
  const { newlines, tail } = shapeOf(text);
  return newlines === 0 ? { line: at.line, column: at.column + tail } : { line: at.line + newlines, column: tail + 1 };
}

/** Where text appended after `prefix` starts. */
export function endOf(prefix: string): WgslPosition {
  return advance({ line: 1, column: 1 }, prefix);
}

/** The span for `text` (from `parameter`, starting at `from` there) written at `at`. */
export function placed(
  parameter: string,
  text: string,
  at: WgslPosition,
  from: WgslPosition = { line: 1, column: 1 },
): AuthoredSpan {
  return { parameter, at, from, lines: shapeOf(text).newlines + 1 };
}

/**
 * The spans for a parameter's text with one range `[start, end)` cut out of it (a hoisted
 * `struct Params`), the remainder written at `at`.
 *
 * Lines before the cut map straight. The line the cut joins is the author's END line when
 * the cut started at a line's first column (the usual shape — a struct on its own lines), so
 * a position after the struct's `}` lands on the right character; when something preceded
 * the struct on its line, that line is mapped as the START line, which is exact for the
 * part before the cut. Lines after the joint map one-for-one onto the lines after the cut.
 */
export function placedAroundCut(
  parameter: string,
  source: string,
  start: number,
  end: number,
  at: WgslPosition,
): AuthoredSpan[] {
  if (end <= start) return [placed(parameter, source, at)];
  const before = source.slice(0, start);
  const cutStart = endOf(before);
  const cutEnd = endOf(source.slice(0, end));
  const after = source.slice(end);
  const afterLines = shapeOf(after).newlines + 1;
  const spans: AuthoredSpan[] = [];
  if (cutStart.column === 1) {
    if (cutStart.line > 1) spans.push({ parameter, at, from: { line: 1, column: 1 }, lines: cutStart.line - 1 });
    const joint = cutStart.line === 1 ? at : { line: at.line + cutStart.line - 1, column: 1 };
    spans.push({ parameter, at: joint, from: cutEnd, lines: afterLines });
    return spans;
  }
  spans.push({ parameter, at, from: { line: 1, column: 1 }, lines: cutStart.line });
  if (afterLines > 1) {
    spans.push({
      parameter,
      at: { line: at.line + cutStart.line, column: 1 },
      from: { line: cutEnd.line + 1, column: 1 },
      lines: afterLines - 1,
    });
  }
  return spans;
}

/**
 * T1535b — a map counted in one text, once that text is written into a bigger one starting
 * at `at`: a Material · WGSL says where its author's bytes sit in its own `code`, and only
 * the Scene's generator knows where `code` lands in the draw pass. A span on the text's
 * first line moves sideways with it; every other line keeps its column.
 */
export function relocated(map: WgslSourceMap, at: WgslPosition): AuthoredSpan[] {
  return map.map((span) => ({
    ...span,
    at:
      span.at.line === 1
        ? { line: at.line, column: at.column + span.at.column - 1 }
        : { line: at.line + span.at.line - 1, column: span.at.column },
  }));
}

/**
 * The author's position for a device position, or undefined when it falls in generated
 * code. On a span's first line a column left of where the author's text begins is the
 * generator's, not the author's.
 */
export function authoredPosition(map: WgslSourceMap, position: WgslPosition): AuthoredPosition | undefined {
  for (const span of map) {
    const offset = position.line - span.at.line;
    if (offset < 0 || offset >= span.lines) continue;
    const node = span.nodeId === undefined ? {} : { nodeId: span.nodeId };
    if (offset > 0) return { parameter: span.parameter, line: span.from.line + offset, column: position.column, ...node };
    if (position.column < span.at.column) continue;
    return {
      parameter: span.parameter,
      line: span.from.line,
      column: span.from.column + (position.column - span.at.column),
      ...node,
    };
  }
  return undefined;
}

/** `readExecutionPlan`'s reading of a pass's `sourceMap`: undefined when absent, null when malformed. */
export function readSourceMap(value: unknown): WgslSourceMap | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const isPosition = (candidate: unknown): candidate is WgslPosition =>
    typeof candidate === "object" &&
    candidate !== null &&
    Number.isInteger((candidate as WgslPosition).line) &&
    (candidate as WgslPosition).line >= 1 &&
    Number.isInteger((candidate as WgslPosition).column) &&
    (candidate as WgslPosition).column >= 1;
  const spans: AuthoredSpan[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { parameter, at, from, lines, nodeId } = entry as Record<string, unknown>;
    if (typeof parameter !== "string" || parameter.length === 0) return null;
    if (!isPosition(at) || !isPosition(from)) return null;
    if (!Number.isInteger(lines) || (lines as number) < 1) return null;
    if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.length === 0)) return null;
    spans.push({ parameter, at, from, lines: lines as number, ...(nodeId === undefined ? {} : { nodeId }) });
  }
  return spans;
}
