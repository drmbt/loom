import { compileGraph, flattenComponents } from "../../compiler/index.ts";
import { createComponentSystem } from "../../domain/components/registry.ts";
import { countNodeNameReferences, rewriteNodeNameReferences } from "../../domain/graph/names.ts";
import { loadProject } from "../../domain/project/load.ts";
import { sortKeysDeep } from "../../domain/project/serialize.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { TIER_B_CAPABILITIES, exampleRegistry } from "../runner.ts";
import type { AppliedRename } from "./apply-rename-map.ts";

/**
 * DOES A RENAMED DOCUMENT STILL DO WHAT IT DID? (T1593b phase 2a)
 *
 * A node's name is not only a caption. Expressions read channels by it (`op('lfo_pathx')`),
 * a Render lists its scenes by it, a preset bank keys its values by it, a cue names its
 * bank by it. Rename a node and miss one of those and the document still loads, still
 * compiles, and quietly does something else. So before 3,000 names move, this asks of each
 * shipped document, on the CPU, with no GPU and no frame:
 *
 *  1. **the same graph**: flatten it before and after. With every name replaced by the id
 *     of the node that holds it, in labels and in every reference, the two flattened graphs
 *     must be the same bytes. A reference that was missed still says the old name, which is
 *     no node's any more, and one that moved to the wrong node says another id.
 *  2. **the same plan**: compile both. Wherever the two plans differ, the difference must
 *     be nothing but a name standing where its other name stood.
 *  3. **no old name left behind**: after the rename, no parameter of the document may still
 *     spell a name that no longer exists. This is the check for the reference kinds the
 *     rename does NOT know. (1) cannot see those: a reference nobody rewrote is the same
 *     text on both sides. A stale name in a note's prose is found here too.
 *  4. **as many references as before**: each renamed node is referred to as often under
 *     its new name as it was under its old one.
 *
 * (1) and (2) use the product's own reference walker to find references, so they inherit
 * its blind spots; (3) reads the text and has none. That is why there are four.
 */

export interface Finding {
  readonly check: "loads" | "flattened graph" | "plan" | "old name left" | "reference count";
  readonly detail: string;
}

export interface Comparison {
  /** What is not the same. Empty means the rename changed nothing but names. */
  readonly findings: readonly Finding[];
  /** Prose that still says an old name: a note's text, a description. Work for the apply, not a failure. */
  readonly mentions: readonly string[];
}

interface Compiled {
  readonly flat: GraphDocument;
  readonly plan: unknown;
  /** Every name in play, as `name → token of the node that holds it`. */
  readonly names: ReadonlyMap<string, string>;
  /** The names in it that no node holds, with their tokens. */
  readonly unheld: ReadonlyMap<string, string>;
}

const token = (nodeId: string): string => `⟦${nodeId}⟧`;

/**
 * `dangling` is the names this side reads that NO node holds (a component reading a node
 * of some other document): they get a token of their own, so the same dangling reference
 * under its old and its new spelling is still the same reference.
 */
function compileShipped(text: string, dangling: ReadonlyMap<string, string>): Compiled | string {
  const { components, nodes: registry } = createComponentSystem(exampleRegistry());
  const loaded = loadProject(text, { nodes: registry, components });
  if (!loaded.ok) return loaded.reason;
  const flattened = flattenComponents({ graph: loaded.document.graph, registry, components: components.view() });
  const plan = compileGraph({
    graph: loaded.document.graph,
    settings: loaded.document.settings,
    registry,
    capabilities: TIER_B_CAPABILITIES,
    components: components.view(),
  });
  const names = new Map<string, string>();
  // Instances first: flattening dissolves them, and a plan may still say their name.
  for (const [nodeId, node] of flattened.instanceNodes) if (node.label !== undefined) names.set(node.label, token(nodeId));
  for (const [nodeId, node] of Object.entries(flattened.graph.nodes)) if (node.label !== undefined) names.set(node.label, token(nodeId));
  const unheld = new Map([...dangling].filter(([name]) => !names.has(name)));
  for (const [name, mark] of unheld) names.set(name, mark);
  return { flat: flattened.graph, plan, names, unheld };
}

/** The flattened graph with every name, in labels and in references, replaced by its node's token. */
function namesAsIds(flat: GraphDocument, unheld: ReadonlyMap<string, string>): string {
  const copy = structuredClone(flat) as GraphDocument;
  const held = Object.keys(copy.nodes).sort().flatMap((nodeId) => {
    const label = copy.nodes[nodeId]?.label;
    return label === undefined ? [] : [{ nodeId, label }];
  });
  for (const { nodeId, label } of held) {
    rewriteNodeNameReferences(copy, label, token(nodeId));
    const node = copy.nodes[nodeId];
    if (node !== undefined) copy.nodes[nodeId] = { ...node, label: token(nodeId) };
  }
  for (const [name, mark] of unheld) rewriteNodeNameReferences(copy, name, mark);
  return JSON.stringify(sortKeysDeep(copy));
}

/** A plan as plain data: maps and sets as lists, in their own order. */
function plain(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return typeof value === "function" ? "§function" : typeof value === "bigint" ? `§${String(value)}` : value;
  if (seen.has(value)) return "§cycle";
  seen.add(value);
  let result: unknown;
  if (value instanceof Map) result = { "§map": [...value].map(([key, entry]) => [plain(key, seen), plain(entry, seen)]) };
  else if (value instanceof Set) result = { "§set": [...value].map((entry) => plain(entry, seen)) };
  else if (ArrayBuffer.isView(value)) result = { "§bytes": [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
  else if (Array.isArray(value)) result = value.map((entry) => plain(entry, seen));
  else {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) record[key] = plain(entry, seen);
    result = record;
  }
  seen.delete(value);
  return result;
}

const WORDS = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu;

/**
 * Are these two texts the same but for a name standing where its other name stood?
 *
 * Word by word, and only a word that DIFFERS has to be explained: it must be a name on the
 * left, a name on the right, and both the name of one node. So a diagnostic that says
 * `Parameter "invert"` about a node once called `invert` is not misread, and neither is the
 * channel in `op('slider_heat').chan.heat`: those words did not change.
 */
function sameButForNames(left: string, right: string, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean {
  if (left === right) return true;
  const leftWords = left.match(WORDS) ?? [];
  const rightWords = right.match(WORDS) ?? [];
  if (leftWords.length !== rightWords.length) return false;
  return leftWords.every((word, index) => {
    const other = rightWords[index] ?? "";
    if (word === other) return true;
    const held = before.get(word);
    return held !== undefined && held === after.get(other);
  });
}

/** Where two plans differ by more than a name. Paths, first few. */
function planDifferences(before: Compiled, after: Compiled): string[] {
  const same = (left: string, right: string): boolean => sameButForNames(left, right, before.names, after.names);
  const found: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (found.length >= 5) return;
    if (typeof left === "string" && typeof right === "string") {
      if (!same(left, right)) found.push(`${path}: "${left.slice(0, 90)}" became "${right.slice(0, 90)}"`);
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) found.push(`${path}: ${String(left.length)} entries became ${String(right.length)}`);
      else left.forEach((entry, index) => walk(entry, right[index], `${path}[${String(index)}]`));
      return;
    }
    if (left !== null && right !== null && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      // A key both sides have is the same key. Only the ones left over may be names (a
      // uniform called `invert` is not the node that was once called `invert`).
      const rightOnly = new Set(Object.keys(rightRecord).filter((key) => !(key in leftRecord)));
      for (const key of Object.keys(leftRecord)) {
        if (key in rightRecord) {
          walk(leftRecord[key], rightRecord[key], `${path}.${key}`);
          continue;
        }
        const match = [...rightOnly].find((candidate) => same(key, candidate));
        if (match === undefined) found.push(`${path}.${key}: gone`);
        else {
          rightOnly.delete(match);
          walk(leftRecord[key], rightRecord[match], `${path}.${key}`);
        }
      }
      for (const key of rightOnly) found.push(`${path}.${key}: new`);
      return;
    }
    if (left !== right) found.push(`${path}: ${JSON.stringify(left)} became ${JSON.stringify(right)}`);
  };
  walk(plain(before.plan), plain(after.plan), "plan");
  return found;
}

interface StoredFile {
  readonly graph?: GraphDocument;
  readonly componentLibrary?: { readonly components?: ReadonlyArray<{ readonly componentId?: unknown; readonly graph?: GraphDocument }> };
}

function graphsOf(text: string): Map<string, GraphDocument> {
  const file = JSON.parse(text) as StoredFile;
  const graphs = new Map<string, GraphDocument>();
  if (file.graph !== undefined) graphs.set("root", file.graph);
  for (const component of file.componentLibrary?.components ?? []) {
    if (component.graph !== undefined) graphs.set(`component ${String(component.componentId)}`, component.graph);
  }
  return graphs;
}

/**
 * Parameters that hold PROGRAM TEXT. A word in a shader is never a node's name: nothing in
 * WGSL can refer to a node. Listed by name, so a new parameter is read until somebody says
 * otherwise.
 */
const PROGRAM_TEXT: ReadonlySet<string> = new Set(["source", "kernel", "attributes", "vertex", "fragment"]);

/**
 * Parameters whose whole value can be spelled like a node's name and is NOT a reference to
 * one, as `type.parameter` → why. Every line here is a hole in check 3, so each says what
 * the value is instead.
 */
const NOT_A_REFERENCE: Readonly<Record<string, string>> = {
  "slider.channel": "the channel this widget publishes: read as `.chan.<name>` off the node, and not the node's name",
  "toggle.channel": "the channel this widget publishes",
  "button.channel": "the channel this widget publishes",
  "xyPad.channel": "the channel this widget publishes",
  "panel.title": "a caption",
};

/** Node types whose every parameter is prose for a person: a note. An old name in one is a mention. */
const PROSE_TYPES: ReadonlySet<string> = new Set(["annotate"]);

/**
 * Fields inside a stored bank, cue list or board that hold a name of their OWN kind (a
 * preset's, a cue's) or a caption. `names.ts` leaves the same fields alone for the same
 * reason: a preset called `out` is not the node that was called `out`.
 */
const NOT_NODE_NAMES: ReadonlySet<string> = new Set(["name", "note", "preset", "label", "title", "current", "standby", "select"]);

/** A string that is nothing but names: `dots1 links1`, `glow.radius, dim`, `lfo1:value`. */
const NAME_LIST = /^\s*[\p{L}\p{N}_]+(?:[.:][\p{L}\p{N}_.*]+)?(?:[\s,]+[\p{L}\p{N}_]+(?:[.:][\p{L}\p{N}_.*]+)?)*\s*$/u;

interface OldNames {
  /** Places that still REFER to a name no node holds. These fail the check. */
  readonly references: string[];
  /** Prose that still mentions one (a note, a description). Reported, never a failure. */
  readonly mentions: string[];
}

/** Old names still spelled somewhere in a renamed graph. */
function oldNamesLeft(graphName: string, after: GraphDocument, applied: readonly AppliedRename[]): OldNames {
  const current = new Set(Object.values(after.nodes).flatMap((node) => (node.label === undefined ? [] : [node.label])));
  const gone = new Set(applied.filter((rename) => rename.graph === graphName && !current.has(rename.old)).map((rename) => rename.old));
  const found: OldNames = { references: [], mentions: [] };
  if (gone.size === 0) return found;
  const words = [...gone].sort((left, right) => right.length - left.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const asWord = new RegExp(`(?<![\\p{L}\\p{N}_.])(?:${words.join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  const asOp = new RegExp(`op\\(\\s*(['"])(?:${words.join("|")})\\1\\s*\\)`, "gu");
  const excerpt = (text: string, at: number, length: number): string =>
    `…${text.slice(Math.max(0, at - 30), at + length + 30).replace(/\s+/g, " ")}…`;

  const readText = (value: string, where: string): void => {
    // A string that is itself JSON (a preset bank, a cue list, a board) is read as what it holds.
    if (/^\s*[{[]/.test(value)) {
      try {
        read(JSON.parse(value) as unknown, where, true);
        return;
      } catch {
        // Not JSON after all: read it as text.
      }
    }
    for (const match of value.matchAll(asOp)) found.references.push(`[${graphName}] ${where} still reads ${match[0]}`);
    if (NAME_LIST.test(value)) {
      for (const piece of value.split(/[\s,]+/)) {
        const head = piece.split(/[.:]/)[0] ?? "";
        if (gone.has(head)) found.references.push(`[${graphName}] ${where} still names "${head}": "${value.trim().slice(0, 80)}"`);
      }
      return;
    }
    const withoutOps = value.replace(asOp, (match) => " ".repeat(match.length));
    for (const match of withoutOps.matchAll(asWord)) found.mentions.push(`[${graphName}] ${where} mentions "${match[0]}": ${excerpt(value, match.index, match[0].length)}`);
  };

  const read = (value: unknown, where: string, keyed: boolean): void => {
    if (typeof value === "string") readText(value, where);
    else if (Array.isArray(value)) value.forEach((entry, index) => read(entry, `${where}[${String(index)}]`, keyed));
    else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      // A record keyed by node name (a preset's values) names nodes in its KEYS. A slot or a
      // binding has keys of its own (`source`, `kind`, `mode`) that a node may share a word with.
      const structural = "kind" in record || "mode" in record || "bindings" in record;
      for (const [key, entry] of Object.entries(record)) {
        if (keyed && !structural && gone.has(key)) found.references.push(`[${graphName}] ${where} still has a record for "${key}"`);
        if (keyed && NOT_NODE_NAMES.has(key) && typeof entry === "string") continue;
        read(entry, `${where}.${key}`, keyed);
      }
    }
  };

  for (const nodeId of Object.keys(after.nodes).sort()) {
    const node = after.nodes[nodeId];
    if (node === undefined) continue;
    for (const [key, value] of Object.entries(node.parameters)) {
      if (PROGRAM_TEXT.has(key) && typeof value === "string") continue;
      if (`${node.type}.${key}` in NOT_A_REFERENCE) continue;
      if (PROSE_TYPES.has(node.type)) {
        const text = typeof value === "string" ? value : "";
        for (const match of text.matchAll(asWord)) found.mentions.push(`[${graphName}] ${nodeId} (${node.type}).${key} mentions "${match[0]}": ${excerpt(text, match.index, match[0].length)}`);
        continue;
      }
      read(value, `${nodeId} (${node.type}).${key}`, false);
    }
  }
  return found;
}

/**
 * Everything that is not the same about one shipped file before and after its rename.
 * Empty means: the same flattened graph, the same plan, no old name left, every reference
 * accounted for.
 */
export function compareRenamed(beforeText: string, afterText: string, applied: readonly AppliedRename[]): Comparison {
  const findings: Finding[] = [];
  const mentions: string[] = [];
  // A name read from outside its graph has no node to be the token of: it is its own.
  const outward = applied.filter((rename) => rename.nodeId === "");
  const before = compileShipped(beforeText, new Map(outward.map((rename) => [rename.old, token(`outside ${rename.old}`)])));
  const after = compileShipped(afterText, new Map(outward.map((rename) => [rename.new, token(`outside ${rename.old}`)])));
  if (typeof before === "string") return { findings: [{ check: "loads", detail: `before: ${before}` }], mentions };
  if (typeof after === "string") return { findings: [{ check: "loads", detail: `after: ${after}` }], mentions };

  if (namesAsIds(before.flat, before.unheld) !== namesAsIds(after.flat, after.unheld)) {
    const left = JSON.parse(namesAsIds(before.flat, before.unheld)) as unknown;
    const right = JSON.parse(namesAsIds(after.flat, after.unheld)) as unknown;
    findings.push({ check: "flattened graph", detail: firstDifference(left, right, "flat") });
  }
  for (const difference of planDifferences(before, after)) findings.push({ check: "plan", detail: difference });

  const beforeGraphs = graphsOf(beforeText);
  for (const [graphName, afterGraph] of graphsOf(afterText)) {
    const left = oldNamesLeft(graphName, afterGraph, applied);
    for (const sentence of left.references) findings.push({ check: "old name left", detail: sentence });
    mentions.push(...left.mentions);
    const beforeGraph = beforeGraphs.get(graphName);
    if (beforeGraph === undefined) continue;
    for (const rename of applied) {
      if (rename.graph !== graphName) continue;
      const was = countNodeNameReferences(beforeGraph, rename.old);
      const is = countNodeNameReferences(afterGraph, rename.new);
      if (was !== is) findings.push({ check: "reference count", detail: `[${graphName}] ${rename.old} was referred to ${String(was)} times, ${rename.new} is ${String(is)} times` });
    }
  }
  return { findings, mentions };
}

/** The first place two plain values differ, as a sentence. */
function firstDifference(left: unknown, right: unknown, path: string): string {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}: ${String(left.length)} entries became ${String(right.length)}`;
    for (let index = 0; index < left.length; index += 1) {
      if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return firstDifference(left[index], right[index], `${path}[${String(index)}]`);
    }
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) {
      if (JSON.stringify(leftRecord[key]) !== JSON.stringify(rightRecord[key])) return firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
    }
  }
  return `${path}: ${String(JSON.stringify(left)).slice(0, 110)} became ${String(JSON.stringify(right)).slice(0, 110)}`;
}

/** One deliberately broken rename, for showing that the check can fail. */
export interface Sabotage {
  readonly what: string;
  readonly text: string;
}

/**
 * Ways to get this file's rename WRONG, each a whole file's text.
 *
 * For every kind of place a reference moved (by node type and parameter), two mistakes:
 * the reference left on its old name, and the reference moved onto a different node. Plus
 * the wholesale one: every label renamed and no reference rewritten at all.
 */
export function sabotages(beforeText: string, afterText: string, applied: readonly AppliedRename[]): Sabotage[] {
  const before = JSON.parse(beforeText) as StoredFile;
  const made: Sabotage[] = [];
  const seenKinds = new Set<string>();
  const beforeGraph = before.graph;
  const afterGraph = (JSON.parse(afterText) as StoredFile).graph;
  if (beforeGraph === undefined || afterGraph === undefined) return made;
  const rootRenames = applied.filter((rename) => rename.graph === "root");

  for (const nodeId of Object.keys(afterGraph.nodes).sort()) {
    const was = beforeGraph.nodes[nodeId];
    const is = afterGraph.nodes[nodeId];
    if (was === undefined || is === undefined) continue;
    for (const key of Object.keys(is.parameters).sort()) {
      const wasText = JSON.stringify(was.parameters[key]);
      const isText = JSON.stringify(is.parameters[key]);
      if (wasText === isText || wasText === undefined) continue;
      const kind = `${is.type}.${key}`;
      if (seenKinds.has(kind)) continue;
      seenKinds.add(kind);

      // (a) this one parameter keeps its old text: its references still say the old names.
      const stale = JSON.parse(afterText) as StoredFile;
      const staleNode = stale.graph?.nodes[nodeId];
      if (staleNode !== undefined && stale.graph !== undefined) {
        stale.graph.nodes[nodeId] = { ...staleNode, parameters: { ...staleNode.parameters, [key]: was.parameters[key] } as typeof staleNode.parameters };
        made.push({ what: `${kind} on ${nodeId}: its references left on the old names`, text: JSON.stringify(stale) });
      }

      // (b) one reference in it moves to a different node that exists.
      const moved = rootRenames.find((rename) => isText.includes(rename.new));
      const other = rootRenames.find((rename) => moved !== undefined && rename.new !== moved.new && !isText.includes(rename.new));
      if (moved !== undefined && other !== undefined) {
        const wrong = JSON.parse(afterText) as StoredFile;
        const wrongNode = wrong.graph?.nodes[nodeId];
        if (wrongNode !== undefined && wrong.graph !== undefined) {
          const swapped = JSON.parse(isText.replace(moved.new, other.new)) as (typeof wrongNode.parameters)[string];
          wrong.graph.nodes[nodeId] = { ...wrongNode, parameters: { ...wrongNode.parameters, [key]: swapped } };
          made.push({ what: `${kind} on ${nodeId}: a reference to ${moved.new} moved onto ${other.new}`, text: JSON.stringify(wrong) });
        }
      }
    }
  }

  // (c) labels only: what a rename that knew no reference kind at all would write.
  const labelsOnly = JSON.parse(beforeText) as StoredFile;
  if (labelsOnly.graph !== undefined && rootRenames.some((rename) => rename.references > 0)) {
    for (const rename of rootRenames) {
      const node = labelsOnly.graph.nodes[rename.nodeId];
      if (node !== undefined) labelsOnly.graph.nodes[rename.nodeId] = { ...node, label: rename.new };
    }
    made.push({ what: "every label renamed, no reference rewritten", text: JSON.stringify(labelsOnly) });
  }
  return made;
}
