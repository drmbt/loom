import ts from "typescript";
import { NODE_KINDS } from "../../domain/graph/node-kinds.ts";
import { SOURCE_REFERENCE_PARAMETERS } from "../../domain/graph/source-references.ts";

/**
 * Renames nodes in the TEXT that builds or describes a shipped document (T1593b phase 2a):
 * a document's TypeScript source, a test that names its nodes, the page beside it.
 *
 * A node's name is spelled in a source file in a handful of shapes, and only those are
 * touched. Everything else in the file is somebody's code and is left alone, including
 * every string that merely looks like a name:
 *
 *  - `label: "dye1"`: the name itself;
 *  - a parameter that holds names (`scenes: "dots1 links1"`, `material: "ink1"`,
 *    `targets: "glow.radius"`), read from the same table the product renames by;
 *  - `drivenSlot("lfo1:value", …)`, and `op('lfo1')` wherever it is written;
 *  - in comments and pages, the name in backticks.
 *
 * A node's ID is not its name. `node("dim", "level", …, { label: "dim" })` holds the word
 * twice and only the second one moves; the first is an address that edges are written
 * against. That is why this reads the syntax tree rather than the text.
 *
 * What it cannot do it SAYS, as notes with a line number: a name built by a template
 * (`` `${id}1` ``), a name two documents rename differently, a sentence that mentions a
 * name in plain words. Whether the result is RIGHT is not decided here at all. The apply
 * tool builds the documents from the rewritten text and compares them, byte for byte,
 * with the same documents renamed in memory.
 */

export interface NameTable {
  /** Old name → new name, for the names every scope this file belongs to agrees on. */
  readonly names: ReadonlyMap<string, string>;
  /**
   * The same, keyed `type\nold`. A label is written beside its node's type, and two nodes
   * of different types may share an old name (`cut1` on a Mask and on a Threshold) without
   * disagreeing about anything.
   */
  readonly typed: ReadonlyMap<string, string>;
  /** Old names that two of its scopes rename differently: never rewritten, always noted. */
  readonly clash: ReadonlySet<string>;
  /**
   * Old names that are also some node's ID, in ANY shipped document, not only the ones this
   * file builds: a bare literal of one may be either, and a test's own fixture is as likely
   * to borrow the word for an id as for a name.
   */
  readonly idsToo: ReadonlySet<string>;
}

export interface Rewritten {
  readonly text: string;
  /** How many spellings changed. */
  readonly changed: number;
  /** The old names this file spelled as a NAME (a label, a reference): what it authors. */
  readonly spelled: ReadonlySet<string>;
  /** `line N: …` for everything a person has to look at. */
  readonly notes: readonly string[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A string that is nothing but names: `dots1 links1`, `glow.radius, dim`, `lfo1:value`. */
const NAME_LIST = /^\s*[\p{L}\p{N}_]+(?:[.:][\p{L}\p{N}_.*]+)?(?:[\s,]+[\p{L}\p{N}_]+(?:[.:][\p{L}\p{N}_.*]+)?)*\s*$/u;
const OP = /op\(\s*(\\?['"])([^'"\\]+)\1\s*\)/g;
/** `op('name')`, or a name in backticks (with a `.param` or `:channel` after it), or a bare word. */
const PROSE = /op\(\s*(\\?['"])([^'"\\]+)\1\s*\)|`([\p{L}\p{N}_]+)((?:[.:][\p{L}\p{N}_.]+)?)`|(?<![\p{L}\p{N}_.-])([\p{L}\p{N}_]+)(?![\p{L}\p{N}_-])/gu;

/** A name no sentence would contain by accident: it has a digit, an underscore or an inner capital. */
const distinctive = (name: string): boolean => /[0-9_]/.test(name) || /[a-z][A-Z]/.test(name);

/** Parameters that hold names, per node type, and all of them together for a type that is not spelled. */
const REFERENCE_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ...Object.entries(SOURCE_REFERENCE_PARAMETERS).map(([type, specs]) => [type, new Set(specs.map((spec) => spec.parameter))] as const),
  ["channelIn", new Set(["channel"])] as const,
  ["presets", new Set(["targets"])] as const,
]);
const ANY_REFERENCE_KEY: ReadonlySet<string> = new Set(
  [...Object.values(SOURCE_REFERENCE_PARAMETERS).flatMap((specs) => specs.map((spec) => spec.parameter)), "targets"],
);

class Session {
  readonly edits: Edit[] = [];
  readonly notes: string[] = [];
  readonly spelled = new Set<string>();
  changed = 0;
  readonly text: string;
  readonly table: NameTable;
  readonly lineOf: (position: number) => number;

  // Plain fields: plain `node` strips types and cannot run a parameter property.
  constructor(text: string, table: NameTable, lineOf: (position: number) => number) {
    this.text = text;
    this.table = table;
    this.lineOf = lineOf;
  }

  note(position: number, sentence: string): void {
    this.notes.push(`line ${String(this.lineOf(position))}: ${sentence}`);
  }

  replace(start: number, end: number, next: string): void {
    if (this.text.slice(start, end) === next) return;
    this.edits.push({ start, end, text: next });
  }

  /** `op('old')` anywhere in this stretch of text. */
  ops(start: number, end: number): void {
    const raw = this.text.slice(start, end);
    const next = raw.replace(OP, (whole, quote: string, name: string) => {
      if (this.table.clash.has(name)) this.note(start, `op('${name}') is renamed differently in two documents this file builds`);
      const renamed = this.table.names.get(name);
      if (renamed === undefined) return whole;
      this.changed += 1;
      this.spelled.add(name);
      return `op(${quote}${renamed}${quote})`;
    });
    this.replace(start, end, next);
  }

  /** This stretch is the LABEL of a node of this type. Falls back to the name alone when the type is not spelled. */
  label(start: number, end: number, type: string | undefined): boolean {
    const raw = this.text.slice(start, end);
    // A type that is spelled decides it: `grid1` on a Grid stays even though some other
    // document this file builds renames a `grid1` on a Tile.
    if (type === undefined) return this.names(start, end);
    const renamed = this.table.typed.get(`${type}\n${raw}`);
    if (renamed === undefined) return NAME_LIST.test(raw);
    this.changed += 1;
    this.spelled.add(raw);
    this.replace(start, end, renamed);
    return true;
  }

  /** This stretch IS a name or a list of them. Returns false when it is not shaped like one. */
  names(start: number, end: number): boolean {
    const raw = this.text.slice(start, end);
    if (!NAME_LIST.test(raw)) return false;
    const next = raw.split(/([\s,]+)/).map((piece) => {
      const head = piece.split(/[.:]/)[0] ?? "";
      if (this.table.clash.has(head)) this.note(start, `"${head}" is renamed differently in two documents this file builds`);
      const renamed = this.table.names.get(head);
      if (renamed === undefined) return piece;
      this.changed += 1;
      this.spelled.add(head);
      return `${renamed}${piece.slice(head.length)}`;
    }).join("");
    this.replace(start, end, next);
    return true;
  }

  /**
   * A comment, or a page: `op('…')`, a name in backticks, and a distinctive name as a bare
   * word. One pass, so a name that was just written is never read again as an old one.
   * `page` also takes the claim form `name(type)` and any backticked name, distinctive or not.
   */
  prose(start: number, end: number, page: boolean): void {
    const raw = this.text.slice(start, end);
    const next = raw.replace(PROSE, (whole: string, quote: string | undefined, read: string | undefined, ticked: string | undefined, tail: string | undefined, bare: string | undefined, offset: number) => {
      if (read !== undefined) {
        const renamed = this.table.names.get(read);
        if (renamed === undefined) return whole;
        this.changed += 1;
        return `op(${quote ?? "'"}${renamed}${quote ?? "'"})`;
      }
      if (ticked !== undefined) {
        const renamed = this.table.names.get(ticked);
        if (this.table.clash.has(ticked)) this.note(start + offset, `\`${ticked}\` is renamed differently in two documents this text covers`);
        if (renamed === undefined) return whole;
        if (!distinctive(ticked) && !page) {
          this.note(start + offset, `\`${ticked}\` may be the node (it becomes \`${renamed}\`) or the word`);
          return whole;
        }
        this.changed += 1;
        return `\`${renamed}${tail ?? ""}\``;
      }
      const name = bare ?? "";
      const renamed = this.table.names.get(name);
      if (renamed === undefined) return whole;
      const claimed = page && raw.charAt(offset + name.length) === "(";
      if (!distinctive(name) && !claimed) return whole;
      this.changed += 1;
      if (claimed) this.spelled.add(name);
      return renamed;
    });
    this.replace(start, end, next);
  }

  result(): Rewritten {
    let text = this.text;
    for (const edit of [...this.edits].sort((left, right) => right.start - left.start)) text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
    return { text, changed: this.changed, spelled: this.spelled, notes: this.notes };
  }
}

/** The node type an object literal is the parameters (or the extras) of, where the call spells it. */
function builderType(from: ts.Node): string | undefined {
  let at: ts.Node = from;
  while (ts.isObjectLiteralExpression(at) || ts.isPropertyAssignment(at) || ts.isParenthesizedExpression(at) || ts.isAsExpression(at)) at = at.parent;
  if (!ts.isCallExpression(at)) return undefined;
  const second = at.arguments[1];
  return second !== undefined && ts.isStringLiteralLike(second) ? second.text : undefined;
}

/** The type of the node a `label:` belongs to: its sibling `type:`, or the builder call's. */
function labelType(node: ts.Node): string | undefined {
  const assignment = node.parent;
  if (!ts.isPropertyAssignment(assignment) || !(ts.isIdentifier(assignment.name) && assignment.name.text === "label")) return undefined;
  const literal = assignment.parent;
  if (ts.isObjectLiteralExpression(literal)) {
    for (const property of literal.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "type" && ts.isStringLiteralLike(property.initializer)) return property.initializer.text;
    }
  }
  return builderType(assignment);
}

/**
 * Is this string written where a node's ID goes? An id is an address: edges are written
 * against it, and it is never rewritten, whatever name it shares a word with.
 *
 * `node("cut1", componentNodeType("depthCut", 1))` is why this exists. `cut1` is the name
 * of a node inside DepthCut, and here it is the id a test gave its own instance: the sweep's
 * first batch renamed it, in four places, and left the record keyed `cut1` behind.
 */
function idPosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const key = ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : "";
    return key === "nodeId" || key === "id";
  }
  // `graph.nodes["dim"]`
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return /nodes$/i.test(parent.expression.getText());
  // `["dim", "out"]`: an edge's endpoint.
  if (ts.isArrayLiteralExpression(parent) && parent.elements.length === 2 && parent.elements[0] === node) {
    const port = parent.elements[1];
    return port !== undefined && ts.isStringLiteralLike(port);
  }
  // `node("dim", "level", …)`: the first argument of a call whose second says a node type.
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const second = parent.arguments[1];
    if (second === undefined) return false;
    if (ts.isCallExpression(second) || ts.isTemplateExpression(second)) return true;
    return ts.isStringLiteralLike(second) && (second.text in NODE_KINDS || second.text.startsWith("component:") || second.text.includes("."));
  }
  return false;
}

/** Is this expression written where a node's NAME goes? */
function namePosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const key = ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : undefined;
    if (key === undefined) return false;
    if (key === "label" || key === "bank" || key === "member") return true;
    const type = builderType(parent);
    return type === undefined ? ANY_REFERENCE_KEY.has(key) : REFERENCE_KEYS.get(type)?.has(key) === true;
  }
  // An argument of a call: `drivenSlot("lfo1:value", 0)`, and a file's own helpers
  // (`drivenBy("probe:low", 1)`, `cellFit("churnx1", "churny1")`). Not the FIRST argument
  // of a call whose second is a node type: that is `node(id, type, …)`, and an id.
  if (!ts.isCallExpression(parent)) return false;
  const index = parent.arguments.indexOf(node as ts.Expression);
  if (index < 0) return false;
  const second = parent.arguments[1];
  const builds = second !== undefined && (ts.isTemplateExpression(second) || (ts.isStringLiteralLike(second) && (second.text in NODE_KINDS || second.text.startsWith("component:"))));
  return !(index === 0 && builds);
}

/** Functions whose first argument is always a node's name, or `name:channel`. */
const TAKES_A_NAME: ReadonlySet<string> = new Set(["drivenSlot", "channelExpression"]);

/** Is this the key of a record that is keyed by node name: a preset's `values`, its `on`? */
function nameKey(node: ts.Node): boolean {
  const assignment = node.parent;
  if (!ts.isPropertyAssignment(assignment) || assignment.name !== node) return false;
  const record = assignment.parent.parent;
  return ts.isPropertyAssignment(record) && ts.isIdentifier(record.name) && (record.name.text === "values" || record.name.text === "on");
}

function rewriteTypeScript(path: string, text: string, table: NameTable, byPosition: boolean): Rewritten {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const session = new Session(text, table, (position) => source.getLineAndCharacterOfPosition(position).line + 1);

  const literal = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): void => {
    if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return;
    const start = node.getStart(source) + 1;
    const end = node.getEnd() - 1;
    const raw = text.slice(start, end);
    if (idPosition(node)) {
      // Said, so a person can see the word is in use for both; never moved.
      if (table.names.has(raw) || table.clash.has(raw)) session.note(start, `"${raw}" is written as a node's ID here, and is a node's name elsewhere: an id is never moved`);
      return;
    }
    if (!byPosition) {
      // A test: any literal that is a name of the documents it tests. A word that is also
      // a node's id could be either, so it is shown and not moved.
      const heads = NAME_LIST.test(raw) ? raw.trim().split(/[\s,]+/).map((piece) => piece.split(/[.:]/)[0] ?? "") : [];
      const either = heads.find((head) => table.names.has(head) && table.idsToo.has(head));
      if (either !== undefined) session.note(start, `"${either}" is a node's name and, here or in another document, a node's id: left alone`);
      else if (heads.length > 0) session.names(start, end);
      else session.ops(start, end);
      return;
    }
    if (nameKey(node)) {
      session.names(start, end);
      return;
    }
    if (namePosition(node)) {
      const isLabel = ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name) && node.parent.name.text === "label";
      const isArgument = ts.isCallExpression(node.parent);
      // An argument that is also some node's id may be either; a label or a reference parameter is never an id.
      // …unless the function is known to take a name, or the word carries a `:channel`,
      // which no id does.
      const known = isArgument && ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression) && TAKES_A_NAME.has(node.parent.expression.text);
      const either = isArgument && !known && NAME_LIST.test(raw) && raw.trim().split(/[\s,]+/).some((piece) => !/[.:]/.test(piece) && table.idsToo.has(piece));
      if (either) session.note(start, `"${raw}" is passed to a function and is both a node's name and a node's id: left alone`);
      else if (!(isLabel ? session.label(start, end, labelType(node)) : session.names(start, end))) session.ops(start, end);
      return;
    }
    session.ops(start, end);
    // A sentence for a person (a note's body): the names in it are mentions.
    if (/\s/.test(raw) && raw.length > 24) {
      for (const match of raw.matchAll(/(?<![\p{L}\p{N}_.'"])[\p{L}\p{N}_]+(?![\p{L}\p{N}_'"])/gu)) {
        if (table.names.has(match[0]) && distinctive(match[0])) session.note(start, `a sentence mentions "${match[0]}" (it becomes "${table.names.get(match[0]) ?? ""}")`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    // `values: { glow: { … } }`: the key is the node's name, written as an identifier.
    if (byPosition && ts.isIdentifier(node) && nameKey(node)) session.names(node.getStart(source), node.getEnd());
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal(node);
    else if (ts.isTemplateExpression(node)) {
      session.ops(node.head.getStart(source) + 1, node.head.getEnd() - 2);
      for (const span of node.templateSpans) {
        const tail = ts.isTemplateTail(span.literal);
        session.ops(span.literal.getStart(source) + 1, span.literal.getEnd() - (tail ? 1 : 2));
      }
      // Said only where a name certainly goes (a label, a reference parameter): a template
      // handed to some function is usually an expression or a shader.
      if (byPosition && ts.isPropertyAssignment(node.parent) && namePosition(node)) {
        session.note(node.getStart(source), `a name is built here, not written: ${node.getText(source).slice(0, 60)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Comments hang off tokens, and `forEachChild` skips the tokens: walk those separately.
  const seen = new Set<number>();
  const comments = (position: number): void => {
    for (const range of [...(ts.getLeadingCommentRanges(text, position) ?? []), ...(ts.getTrailingCommentRanges(text, position) ?? [])]) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      session.prose(range.pos, range.end, false);
    }
  };
  const tokens = (node: ts.Node): void => {
    comments(node.getFullStart());
    comments(node.getEnd());
    for (const child of node.getChildren(source)) tokens(child);
  };
  tokens(source);
  return session.result();
}

/** A document's own source: names are found by where they are written. */
export function rewriteDocumentSource(path: string, text: string, table: NameTable): Rewritten {
  return rewriteTypeScript(path, text, table, true);
}

/** A test: every literal that is a name of the documents it tests. */
export function rewriteTest(path: string, text: string, table: NameTable): Rewritten {
  return rewriteTypeScript(path, text, table, false);
}

/**
 * A page beside an example: the `name(type)` claims `doc-drift` checks, names in
 * backticks, and `op('…')`.
 */
export function rewritePage(text: string, table: NameTable): Rewritten {
  const starts: number[] = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  const session = new Session(text, table, (position) => starts.findLastIndex((start) => start <= position) + 1);
  session.prose(0, text.length, true);
  return session.result();
}
