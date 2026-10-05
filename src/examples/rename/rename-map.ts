import { conformsToKind, roleOf } from "../../domain/graph/node-kinds.ts";
import { listExamples, listProjectDocuments, listStarterComponentFiles } from "../catalogue.ts";
import { auditedGraphs, type AuditedGraph } from "../node-name-audit.ts";
import { JUDGEMENTS, type Judgement } from "./rename-judgements.ts";
import { mechanicalRole, nameFor, restatedKind, thinRole } from "./rename-rules.ts";

/**
 * THE RENAME MAP: every shipped name that changes, and the rule that changed it (T1593b
 * phase 2a).
 *
 * Built from the shipped bytes, the rules (`rename-rules.ts`) and the decisions a rule
 * could not make (`rename-judgements.ts`). Nothing here writes anything: the map is what a
 * person reviews (`build-rename-map.ts` prints it into `docs/`), what the equivalence check
 * applies in memory (`check-rename-equivalence.ts`) and what the apply tool will write
 * (`apply-rename.ts`).
 *
 * ## A name is decided once per SCOPE, not once per file
 *
 * The same node ships in many files. A starter component's graph is embedded in every
 * example that uses it; a project's shots are two dozen documents built by shared source.
 * If each file decided for itself, one node could end with two names and the source that
 * builds both could not be rewritten at all. So:
 *
 *  - an example's root graph is a scope of its own;
 *  - an embedded component is ONE scope wherever it is embedded (`component <id>@<v>`);
 *  - a project is one scope across all its documents (`projects/<name>`).
 *
 * `auditRenameMap` proves that holds: every graph the map touches ends with unique names
 * that all carry their kind.
 */

/** Left out on purpose: that session renames its own names (lead's instruction, 2026-10-05). */
export const EXCLUDED_PREFIXES: readonly string[] = ["projects/sentinel-bot/"];

export interface ShippedDocument {
  /** Relative to the repository root: `examples/E13-Prism.loom.json`. */
  readonly path: string;
  readonly text: string;
}

/** Every shipped document the sweep covers, in a stable order. */
export function shippedDocuments(): ShippedDocument[] {
  const all = [
    ...listExamples().map((file) => ({ path: `examples/${file.fileName}`, text: file.text })),
    ...listStarterComponentFiles().map((file) => ({ path: `examples/components/${file.fileName}`, text: file.text })),
    ...listProjectDocuments().map((file) => ({ path: `projects/${file.fileName}`, text: file.text })),
  ];
  return all.filter((document) => !EXCLUDED_PREFIXES.some((prefix) => document.path.startsWith(prefix)));
}

/** The scope a graph of a shipped file is decided in. */
export function scopeOf(path: string, graph: AuditedGraph): string {
  if (graph.component !== null) return `component ${graph.component.id}@${String(graph.component.version)}`;
  if (path.startsWith("projects/")) return `projects/${path.split("/")[1] ?? ""}`;
  return path;
}

export type RenameRule =
  /** The label was the node's id plus `1`: the `1` goes, the kind comes in front. */
  | "habit"
  /** A lone trailing `1` on some other word: the same. */
  | "number"
  /** One of a numbered run: the number stays. */
  | "series"
  /** No number: the kind comes in front. */
  | "as-is"
  /** Already `kind_role`, with the habit's `1` still on the role: the `1` goes. */
  | "conforming-habit"
  /** The role said the kind again at one end (`wallgrid` on a Grid): that word goes. */
  | "restated"
  /** The role was ONLY the kind (`out` on an Output): the name is the kind and a number. */
  | "kind-only"
  /** A person decided it. */
  | "judged"
  /**
   * Not a node of this scope at all: a component's graph reads a node of the document it
   * was saved from, by name. The reference follows that node to its new name, in every
   * file that embeds the component, so the component stays one definition.
   */
  | "outward";

/** Rules whose every case is listed for review. */
export const REVIEWED_RULES: readonly RenameRule[] = ["judged", "kind-only", "restated"];

export interface RenameEntry {
  readonly scope: string;
  readonly type: string;
  readonly kind: string;
  readonly old: string;
  readonly new: string;
  readonly rule: RenameRule;
  /** One line: why this name. Always present on a reviewed rule. */
  readonly reason?: string;
  /** What the rules alone would have given, where a person chose otherwise. */
  readonly mechanical?: string;
  /** True where the proposer could not tell and wants a second opinion. */
  readonly unsure?: true;
  /** The node ids that carry it, across the scope. */
  readonly nodeIds: readonly string[];
  /** How many nodes, across every file of the scope. */
  readonly occurrences: number;
  /** The files it occurs in. */
  readonly files: readonly string[];
}

export interface RenameMap {
  readonly entries: readonly RenameEntry[];
  /** Judgements that matched no shipped name: a stale decision is a mistake in waiting. */
  readonly unusedJudgements: readonly Judgement[];
  /** Thin roles nobody decided, as `scope: kind old → new`. Must be empty to ship. */
  readonly undecided: readonly string[];
}

interface Occurrence {
  readonly path: string;
  readonly nodeId: string;
}

interface Pending {
  readonly scope: string;
  readonly type: string;
  readonly kind: string;
  readonly old: string;
  readonly occurrences: Occurrence[];
}

const judgementScope = (scope: string): string =>
  scope.replace(/^examples\/components\//, "components/").replace(/^examples\//, "").replace(/\.loom\.json$/, "");

function judgementFor(scope: string, kind: string, old: string, used: Set<Judgement>): Judgement | undefined {
  const short = judgementScope(scope);
  const found = JUDGEMENTS.find((entry) => entry.kind === kind && entry.old === old && (entry.scope === "*" || entry.scope === short));
  if (found !== undefined) used.add(found);
  return found;
}

/** The map, from these documents. Pure: the same bytes give the same map. */
export function buildRenameMap(documents: readonly ShippedDocument[]): RenameMap {
  const pending = new Map<string, Pending>();
  const namesIn = new Map<string, Set<string>>();
  const seenComponentIn = new Map<string, string>();

  for (const document of documents) {
    for (const graph of auditedGraphs(document.text)) {
      const scope = scopeOf(document.path, graph);
      // A component's graph is the same bytes wherever it is embedded: count it where it is
      // first seen, so `occurrences` is nodes and not nodes times embeddings.
      const first = graph.component === null ? document.path : (seenComponentIn.get(scope) ?? document.path);
      if (graph.component !== null) seenComponentIn.set(scope, first);
      for (const node of graph.nodes) {
        if (node.name === undefined) continue;
        // A run is counted among nodes of ONE kind: `drift1` on a Kernel and `drift2` on an
        // LFO were only numbered apart because nothing else told them apart. The kind does now.
        const names = namesIn.get(`${scope}\n${node.kind}`) ?? new Set<string>();
        namesIn.set(`${scope}\n${node.kind}`, names);
        names.add(node.name);
        if (!node.bound) continue;
        const key = `${scope}\n${node.type}\n${node.name}`;
        const entry = pending.get(key) ?? { scope, type: node.type, kind: node.kind, old: node.name, occurrences: [] };
        pending.set(key, entry);
        if (first === document.path) entry.occurrences.push({ path: document.path, nodeId: node.id });
        else if (!entry.occurrences.some((occurrence) => occurrence.path === document.path)) entry.occurrences.push({ path: document.path, nodeId: "" });
      }
    }
  }

  const used = new Set<Judgement>();
  const undecided: string[] = [];
  const entries: RenameEntry[] = [];
  for (const { scope, type, kind, old, occurrences } of [...pending.values()].sort(byScopeThenName)) {
    const real = occurrences.filter((occurrence) => occurrence.nodeId !== "");
    const nodeIds = [...new Set(real.map((occurrence) => occurrence.nodeId))].sort();
    const files = [...new Set(occurrences.map((occurrence) => occurrence.path))].sort();
    const siblings = new Set([...(namesIn.get(`${scope}\n${kind}`) ?? [])].filter((name) => name !== old));
    const shared = { scope, type, kind, old, nodeIds, occurrences: real.length, files };
    const judgement = judgementFor(scope, kind, old, used);

    if (conformsToKind(old, kind)) {
      // Already `kind_role`. The only thing left to take off is the habit's `1`, and only
      // where every node carrying the name got it by the habit.
      const role = roleOf(old, kind);
      const byHabit = role !== null && role !== "" && nodeIds.length > 0
        && nodeIds.every((id) => mechanicalRole(id, old, siblings).rule === "habit");
      if (judgement !== undefined) {
        entries.push({ ...shared, new: nameFor(kind, judgement.role, 1), rule: "judged", reason: judgement.reason, ...(judgement.unsure === true ? { unsure: true as const } : {}) });
      } else if (byHabit) {
        const first = nodeIds[0] ?? "";
        entries.push({ ...shared, new: nameFor(kind, roleOf(mechanicalRole(first, old, siblings).role, kind) ?? "", 1), rule: "conforming-habit" });
      }
      continue;
    }

    // What the rules give. Nodes that share a name but not an id may disagree about the
    // habit; the commonest reading wins and the judgement list says so.
    const readings = nodeIds.map((id) => mechanicalRole(id, old, siblings));
    const mechanical = commonest(readings.map((reading) => `${reading.rule}\n${reading.role}`)).split("\n");
    const rule = (mechanical[0] ?? "as-is") as RenameRule;
    const role = mechanical[1] ?? old;
    const restated = restatedKind(role, kind);
    const ruleRole = restated === null ? role : restated.rest;
    const ruleName = nameFor(kind, ruleRole, 1);

    if (judgement !== undefined) {
      const chosen = nameFor(kind, judgement.role, 1);
      entries.push({
        ...shared,
        new: chosen,
        rule: "judged",
        reason: judgement.reason,
        ...(chosen === ruleName ? {} : { mechanical: ruleName }),
        ...(judgement.unsure === true ? { unsure: true as const } : {}),
      });
      continue;
    }
    if (restated !== null) {
      // `renderpoints2` leaves only `2`: no role, and its own number instead of a fresh one.
      const counted = /^[0-9]$/.test(restated.rest);
      entries.push({
        ...shared,
        new: ruleName,
        rule: restated.rest === "" || counted ? "kind-only" : "restated",
        reason: restated.rest === ""
          ? `\`${role}\` only says ${kind} again, so the node is numbered as auto-naming would`
          : counted
            ? `\`${restated.word}\` only says ${kind} again; the node keeps its number`
            : `\`${restated.word}\` says ${kind} again; \`${restated.rest}\` is the author's word`,
      });
      if (restated.rest !== "" && !counted && thinRole(restated.rest)) undecided.push(`${scope}: ${kind} ${old} → ${ruleName}`);
      continue;
    }
    if (thinRole(ruleRole)) undecided.push(`${scope}: ${kind} ${old} → ${ruleName}`);
    entries.push({ ...shared, new: ruleName, rule });
  }

  entries.push(...outwardReferences(documents, entries));
  return { entries, unusedJudgements: JUDGEMENTS.filter((entry) => !used.has(entry)), undecided };
}

interface StoredGraphs {
  readonly graph?: { readonly nodes?: Readonly<Record<string, { readonly label?: unknown; readonly type?: unknown }>> };
  readonly componentLibrary?: {
    readonly components?: ReadonlyArray<{
      readonly componentId?: unknown;
      readonly version?: unknown;
      readonly graph?: { readonly nodes?: Readonly<Record<string, { readonly label?: unknown; readonly parameters?: unknown }>> };
    }>;
  };
}

/**
 * The names a component's graph reads that are not its own.
 *
 * A component saved out of a document keeps its expressions, and one of them may name a
 * node that stayed behind (Kaleidoscope's `facets` reads the two LFOs beside it in the
 * document it ships in). Inside the component no node holds that name, so renaming the
 * component's own nodes never touches it; in the HOME document the node it names is being
 * renamed. The reference has to follow, or the home document quietly stops doing it.
 *
 * Home is the file whose ROOT graph holds the name. Where a component is embedded
 * elsewhere the reference dangles today and dangles after, under the new spelling.
 */
function outwardReferences(documents: readonly ShippedDocument[], decided: readonly RenameEntry[]): RenameEntry[] {
  const found = new Map<string, RenameEntry>();
  for (const document of documents) {
    const file = JSON.parse(document.text) as StoredGraphs;
    const rootNodes = Object.values(file.graph?.nodes ?? {});
    for (const component of file.componentLibrary?.components ?? []) {
      const scope = `component ${String(component.componentId)}@${String(Number(component.version))}`;
      const inner = new Set(Object.values(component.graph?.nodes ?? {}).flatMap((node) => (typeof node.label === "string" ? [node.label] : [])));
      for (const [nodeId, node] of Object.entries(component.graph?.nodes ?? {})) {
        for (const match of JSON.stringify(node.parameters ?? {}).matchAll(/op\(\s*\\?['"]([^'"\\]+)\\?['"]\s*\)/g)) {
          const old = match[1] ?? "";
          if (inner.has(old)) continue;
          const holder = rootNodes.find((candidate) => candidate.label === old);
          if (holder === undefined) continue;
          const home = decided.find((entry) => entry.scope === document.path && entry.old === old && entry.type === holder.type);
          if (home === undefined) continue;
          const key = `${scope}\n${old}`;
          const before = found.get(key);
          found.set(key, {
            scope,
            type: "",
            kind: home.kind,
            old,
            new: home.new,
            rule: "outward",
            reason: `\`${nodeId}\` inside the component reads this node of ${document.path}, where it becomes \`${home.new}\``,
            nodeIds: [...new Set([...(before?.nodeIds ?? []), nodeId])].sort(),
            occurrences: 0,
            files: [document.path],
          });
        }
      }
    }
  }
  return [...found.values()];
}

function byScopeThenName(left: Pending, right: Pending): number {
  return left.scope.localeCompare(right.scope) || left.old.localeCompare(right.old) || left.type.localeCompare(right.type);
}

function commonest(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? "";
}

/** `type\nold` → new, for one scope. What an apply reads. */
export type ScopeRenames = ReadonlyMap<string, string>;

export const renameKey = (type: string, old: string): string => `${type}\n${old}`;

/** The key of a name a component reads from OUTSIDE its own graph: no node of the scope holds it. */
export const outwardKey = (old: string): string => renameKey("", old);

/** The map as a lookup: scope → (`type\nold` → new). */
export function renamesByScope(map: RenameMap): ReadonlyMap<string, ScopeRenames> {
  const byScope = new Map<string, Map<string, string>>();
  for (const entry of map.entries) {
    const scope = byScope.get(entry.scope) ?? new Map<string, string>();
    byScope.set(entry.scope, scope);
    scope.set(renameKey(entry.type, entry.old), entry.new);
  }
  return byScope;
}

/**
 * What is wrong with this map, as sentences. Empty when it is sound.
 *
 * Applies the map to every graph of every document by name alone (no references, no
 * registry) and checks what a sweep must leave true: every bound name carries its kind,
 * and no graph holds one name twice. A map that passes can be applied; whether applying it
 * changes what the document DOES is the equivalence check's question, not this one's.
 */
export function auditRenameMap(map: RenameMap, documents: readonly ShippedDocument[]): string[] {
  const problems: string[] = [];
  const byScope = renamesByScope(map);
  for (const document of documents) {
    for (const graph of auditedGraphs(document.text)) {
      const scope = scopeOf(document.path, graph);
      const renames = byScope.get(scope);
      const holders = new Map<string, string[]>();
      for (const node of graph.nodes) {
        if (node.name === undefined) continue;
        if (renames?.has(outwardKey(node.name)) === true) problems.push(`${document.path} [${graph.graph}]: "${node.name}" is listed as read from outside this graph, and a node of it holds that name.`);
        const next = renames?.get(renameKey(node.type, node.name)) ?? node.name;
        holders.set(next, [...(holders.get(next) ?? []), `${node.id} (was ${node.name})`]);
        if (node.bound && !conformsToKind(next, node.kind)) {
          problems.push(`${document.path} [${graph.graph}]: ${node.id} would be "${next}", which does not carry its kind "${node.kind}".`);
        }
      }
      for (const [name, nodes] of holders) {
        if (nodes.length > 1) problems.push(`${document.path} [${graph.graph}]: "${name}" would name ${String(nodes.length)} nodes: ${nodes.join(", ")}.`);
      }
    }
  }
  for (const line of map.undecided) problems.push(`Nobody decided a thin role: ${line}.`);
  for (const judgement of map.unusedJudgements) problems.push(`A judgement matches no shipped name: ${judgement.scope} ${judgement.kind} ${judgement.old}.`);
  return [...new Set(problems)];
}
