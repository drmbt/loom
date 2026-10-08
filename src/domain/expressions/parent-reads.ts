import { parseExpression, PARENT_FUNCTION, type ExpressionAst } from "./evaluate.ts";

/**
 * VN36: `parent(n).par.key` in one expression source, read and rewritten by its SPAN.
 *
 * The grammar parses the read; this is how a caller that has the scope turns it into one it
 * can evaluate without one. The flattener rewrites each read to an `op()` read of the
 * instance it names (`compiler/parent-references.ts`), and `component.detach` rewrites it one
 * level outward. Both splice the text at the span the parser recorded, so nothing here
 * re-serialises an expression or matches it with a pattern: a `'parent()'` inside an `op()`
 * name is a string, never a read.
 */
export interface ParentRead {
  /** 1 = the component the node is in, 2 = the one around that, and so on. */
  readonly hops: number;
  readonly key: string;
  /** `parent().par.color.r` reads one component of a compound (§V113). */
  readonly component: string | undefined;
  /** Its span in the source AS GIVEN (not trimmed). */
  readonly at: number;
  readonly end: number;
}

/**
 * Every `parent()` read in `source`, in source order. Empty when there is none, and when the
 * source does not parse: such a source reads nothing, and its own syntax error says so.
 */
export function parentReadsOf(source: string): ParentRead[] {
  // Cheap refusal first: this runs over every expression slot of every flattening.
  if (!source.includes(PARENT_FUNCTION)) return [];
  const parsed = parseExpression(source);
  if (!parsed.ok) return [];
  const offset = source.length - source.trimStart().length;
  const reads: ParentRead[] = [];
  const walk = (ast: ExpressionAst): void => {
    switch (ast.kind) {
      case "parentRef":
        reads.push({ hops: ast.hops, key: ast.path[1] ?? "", component: ast.path[2], at: ast.at + offset, end: ast.end + offset });
        return;
      case "unary":
        walk(ast.operand);
        return;
      case "binary":
        walk(ast.left);
        walk(ast.right);
        return;
      case "call":
        for (const arg of ast.args) walk(arg);
        return;
      case "opRef":
      case "number":
      case "variable":
        return;
    }
  };
  walk(parsed.ast);
  return reads.sort((a, b) => a.at - b.at);
}

/**
 * `source` with each `parent()` read replaced by what `replace` returns for it. A read
 * `replace` returns `undefined` for is left as written. Spliced right to left, so every span
 * still holds when it is reached.
 */
export function rewriteParentReads(source: string, replace: (read: ParentRead) => string | undefined): string {
  let rewritten = source;
  for (const read of parentReadsOf(source).reverse()) {
    const replacement = replace(read);
    if (replacement !== undefined) rewritten = rewritten.slice(0, read.at) + replacement + rewritten.slice(read.end);
  }
  return rewritten;
}

/** How a read is written: `parent().par.gain`, `parent(2).par.tint.r`. */
export function formatParentRead(read: Pick<ParentRead, "hops" | "key" | "component">): string {
  return `${PARENT_FUNCTION}(${read.hops === 1 ? "" : read.hops}).par.${read.key}${read.component === undefined ? "" : `.${read.component}`}`;
}
