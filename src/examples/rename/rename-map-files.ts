import { NODE_KINDS } from "../../domain/graph/node-kinds.ts";
import { listExamples, listProjectDocuments, listStarterComponentFiles } from "../catalogue.ts";
import { auditedGraphs, unconformingNames } from "../node-name-audit.ts";
import { EXCLUDED_PREFIXES, REVIEWED_RULES, scopeOf, type RenameEntry, type RenameMap, type RenameRule, type ShippedDocument } from "./rename-map.ts";

/**
 * The rename map as the two files a person reviews (T1593b phase 2a): the whole map as
 * JSON, and a page that puts the part a rule decided into counts and the part a person
 * decided into lists. Pure text out; `build-rename-map.ts` writes it.
 */

export const MAP_JSON_PATH = "docs/node-rename-map-2026-10-05.json";
export const MAP_PAGE_PATH = "docs/node-rename-map-2026-10-05.md";

const RULE_SENTENCES: Readonly<Record<RenameRule, string>> = {
  habit: "The label was the node's id plus `1`. The `1` goes and the kind comes in front.",
  number: "A lone trailing `1` on some other word. The same.",
  series: "One of a numbered run. The number tells them apart and stays.",
  "as-is": "No number at all. The kind comes in front.",
  "conforming-habit": "Already `kind_role`, with the habit's `1` still on the role. The `1` goes.",
  restated: "The role said the kind again at one end (`wallgrid` on a Grid). That word goes.",
  "kind-only": "The role was only the kind (`out` on an Output). The node is the kind and a number.",
  judged: "A person decided it.",
  outward: "Not a node of the scope: a component reads a node of the document it ships in. The reference follows it.",
};

const RULE_ORDER: readonly RenameRule[] = ["habit", "number", "series", "as-is", "conforming-habit", "restated", "kind-only", "judged", "outward"];

const short = (scope: string): string =>
  scope.replace(/^examples\/components\//, "components/").replace(/^examples\//, "").replace(/\.loom\.json$/, "");

/** `E45` for an example, the short scope otherwise: a column narrow enough to list ten of. */
const tag = (scope: string): string => /^examples\/E[0-9]+-/.exec(scope)?.[0].slice(9, -1) ?? short(scope);

interface Counts {
  readonly entries: number;
  readonly nodes: number;
}

function countsByRule(map: RenameMap): Map<RenameRule, Counts> {
  const counts = new Map<RenameRule, Counts>();
  for (const entry of map.entries) {
    const before = counts.get(entry.rule) ?? { entries: 0, nodes: 0 };
    counts.set(entry.rule, { entries: before.entries + 1, nodes: before.nodes + entry.occurrences });
  }
  return counts;
}

/** How the gate's count of names that do not conform divides: left out, embedded again, decided here. */
export interface GateReconciliation {
  /** Every name the gate counts, over every shipped file. */
  readonly gate: number;
  /** Of those, in files this map leaves out. */
  readonly excluded: number;
  /** Of those, a component's graph embedded in a second and further file. */
  readonly embeddedAgain: number;
  /** Distinct nodes this map renames that do not conform today. */
  readonly decided: number;
  /** Nodes this map renames although they conform today (`conforming-habit`, and judgements on them). */
  readonly alreadyConforming: number;
}

export function reconcileWithGate(map: RenameMap): GateReconciliation {
  const everyFile = [
    ...listExamples().map((file) => ({ path: `examples/${file.fileName}`, text: file.text })),
    ...listStarterComponentFiles().map((file) => ({ path: `examples/components/${file.fileName}`, text: file.text })),
    ...listProjectDocuments().map((file) => ({ path: `projects/${file.fileName}`, text: file.text })),
  ];
  let gate = 0;
  let excluded = 0;
  let embeddedAgain = 0;
  const seen = new Set<string>();
  for (const file of everyFile) {
    const found = unconformingNames(file.text).length;
    gate += found;
    if (EXCLUDED_PREFIXES.some((prefix) => file.path.startsWith(prefix))) {
      excluded += found;
      continue;
    }
    for (const graph of auditedGraphs(file.text)) {
      if (graph.component === null) continue;
      const scope = scopeOf(file.path, graph);
      const unconforming = unconformingNames(file.text).filter((name) => name.graph === graph.graph).length;
      if (seen.has(scope)) embeddedAgain += unconforming;
      seen.add(scope);
    }
  }
  const total = map.entries.reduce((sum, entry) => sum + entry.occurrences, 0);
  const decided = gate - excluded - embeddedAgain;
  return { gate, excluded, embeddedAgain, decided, alreadyConforming: total - decided };
}

/** The whole map as JSON: what the apply tool and the equivalence check must agree with. */
export function renameMapJson(map: RenameMap, documents: readonly ShippedDocument[]): string {
  const filesOf = new Map<string, Set<string>>();
  for (const document of documents) {
    for (const graph of auditedGraphs(document.text)) {
      const scope = scopeOf(document.path, graph);
      filesOf.set(scope, (filesOf.get(scope) ?? new Set<string>()).add(document.path));
    }
  }
  const scopes = [...new Set(map.entries.map((entry) => entry.scope))].sort();
  const byRule = Object.fromEntries(RULE_ORDER.flatMap((rule) => {
    const counts = countsByRule(map).get(rule);
    return counts === undefined ? [] : [[rule, counts]];
  }));
  const body = {
    task: "T1593b phase 2a: node names carry their kind",
    reviewedAs: MAP_PAGE_PATH,
    excluded: EXCLUDED_PREFIXES.map((prefix) => `${prefix}**`),
    counts: { documents: documents.length, scopes: scopes.length, entries: map.entries.length, nodes: map.entries.reduce((sum, entry) => sum + entry.occurrences, 0), byRule },
    scopes: scopes.map((scope) => {
      const files = [...(filesOf.get(scope) ?? [])].sort();
      return {
        scope,
        files,
        renames: map.entries.filter((entry) => entry.scope === scope).map((entry) => ({
          type: entry.type,
          kind: entry.kind,
          old: entry.old,
          new: entry.new,
          rule: entry.rule,
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          ...(entry.mechanical === undefined ? {} : { mechanical: entry.mechanical }),
          ...(entry.unsure === true ? { unsure: true } : {}),
          nodeIds: entry.nodeIds,
          nodes: entry.occurrences,
          // Only where it is not simply every file of the scope.
          ...(entry.files.length === files.length ? {} : { files: entry.files }),
        })),
      };
    }),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

const code = (text: string): string => `\`${text}\``;

/** Three samples of a rule, from three different kinds where there are that many. */
function samples(entries: readonly RenameEntry[]): string {
  const picked: RenameEntry[] = [];
  for (const entry of entries) {
    if (picked.some((other) => other.kind === entry.kind)) continue;
    picked.push(entry);
    if (picked.length === 3) break;
  }
  for (const entry of entries) {
    if (picked.length === 3) break;
    if (!picked.includes(entry)) picked.push(entry);
  }
  return picked.map((entry) => `${code(entry.old)} → ${code(entry.new)} (${tag(entry.scope)})`).join(", ");
}

interface Pair {
  readonly kind: string;
  readonly old: string;
  readonly new: string;
  readonly reason: string;
  readonly scopes: string[];
  nodes: number;
}

/** The same decision made in several scopes, as one row. */
function pairs(entries: readonly RenameEntry[]): Pair[] {
  const byKey = new Map<string, Pair>();
  for (const entry of entries) {
    const key = `${entry.kind}\n${entry.old}\n${entry.new}`;
    const pair = byKey.get(key) ?? { kind: entry.kind, old: entry.old, new: entry.new, reason: entry.reason ?? "", scopes: [], nodes: 0 };
    byKey.set(key, pair);
    pair.scopes.push(tag(entry.scope));
    pair.nodes += entry.occurrences;
  }
  return [...byKey.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.old.localeCompare(right.old));
}

const where = (scopes: readonly string[]): string =>
  scopes.length <= 4 ? scopes.join(", ") : `${scopes.slice(0, 3).join(", ")} and ${String(scopes.length - 3)} more`;

/** Shipped names that land on a kind word a reader might not guess, for the owner's look at the table. */
const KINDS_TO_SHOW: readonly string[] = ["sample", "texturepoints", "audiofile", "generator", "pattern", "note"];

/** The page a person reviews. */
export function renameMapPage(map: RenameMap, documents: readonly ShippedDocument[]): string {
  const counts = countsByRule(map);
  const gate = reconcileWithGate(map);
  const total = map.entries.reduce((sum, entry) => sum + entry.occurrences, 0);
  const of = (rule: RenameRule): RenameEntry[] => map.entries.filter((entry) => entry.rule === rule);
  const lines: string[] = [];
  const say = (...text: string[]): void => void lines.push(...text);

  say(
    "# The rename map: every shipped node name, old and new",
    "",
    "T1593b phase 2a, 2026-10-05. **Nothing shipped has been written.** This is the list phase 2b will apply.",
    "",
    `Generated by \`src/examples/rename/build-rename-map.ts\` from the shipped bytes; the whole map, one row per name, is [\`${MAP_JSON_PATH.replace("docs/", "")}\`](${MAP_JSON_PATH.replace("docs/", "")}). Do not edit either file: change \`rename-rules.ts\` or \`rename-judgements.ts\` and run it again.`,
    "",
    "## What it covers",
    "",
    `${String(documents.length)} documents: every example, every starter component and the furnace and on-nothing projects. **\`projects/sentinel-bot/**\` and \`src/projects/sentinel-bot/**\` are left out**: that session renames its own names.`,
    "",
    `The gate counts ${gate.gate.toLocaleString("en")} names that do not carry their kind. ${String(gate.excluded)} of them are sentinel-bot's. ${String(gate.embeddedAgain)} are a starter component's graph embedded again in a second and further example, which is one decision and not several. That leaves **${gate.decided.toLocaleString("en")} nodes**, and this map renames all of them, plus ${String(gate.alreadyConforming)} that conform already and still carry the old habit's \`1\` (below). ${total.toLocaleString("en")} nodes, ${map.entries.length.toLocaleString("en")} distinct names.`,
    "",
    "A name is decided once per **scope**: an example's own graph, a component's graph wherever it is embedded, or a whole project. So the source that builds two dozen on-nothing shots can be rewritten with one answer per name.",
    "",
    "## What a rule decided",
    "",
    "| rule | what it does | names | nodes | three of them |",
    "| --- | --- | ---: | ---: | --- |",
  );
  for (const rule of RULE_ORDER) {
    const count = counts.get(rule);
    if (count === undefined) continue;
    say(`| ${rule} | ${RULE_SENTENCES[rule]} | ${count.entries.toLocaleString("en")} | ${count.nodes.toLocaleString("en")} | ${samples(of(rule))} |`);
  }
  say(
    "",
    "The first five rows need no review beyond these samples: the author's word is kept exactly, capitals included (`geometry_raysB`, `wgsl_finalGrade`). No word is respelled and camelCase is not turned into underscores.",
    "",
    "The last three are listed in full below, because each one is somebody's opinion about a word.",
    "",
  );

  // ── judged ──────────────────────────────────────────────────────────────────────────────
  const judged = of("judged");
  say(
    `## Decided by hand (${String(judged.length)} names)`,
    "",
    `Where the rules left one or two characters, the node got a word for what it is FOR in that document, read from the example's source and its wiring. Its whole chain was renamed with it, so a row of three does not mix two spellings.${judged.some((entry) => entry.unsure === true) ? " **?** marks the ones the proposer could not tell." : ""}`,
    "",
  );
  for (const scope of [...new Set(judged.map((entry) => entry.scope))]) {
    say(`**${short(scope)}**`, "", "| old | new | why | the rules alone |", "| --- | --- | --- | --- |");
    for (const entry of judged.filter((other) => other.scope === scope)) {
      say(`| ${code(entry.old)} | ${code(entry.new)}${entry.unsure === true ? " **?**" : ""} | ${entry.reason ?? ""} | ${entry.mechanical === undefined ? "the same" : code(entry.mechanical)} |`);
    }
    say("");
  }

  // ── kind-only ───────────────────────────────────────────────────────────────────────────
  const kindOnly = pairs(of("kind-only"));
  say(
    `## The role was only the kind (${String(kindOnly.length)} distinct, ${String(counts.get("kind-only")?.nodes ?? 0)} nodes)`,
    "",
    "The old name said nothing but what the node is, in the author's short form or as a piece of the kind's own word. There is no role to keep, so the node gets what auto-naming gives a new one.",
    "",
    "| old | new | nodes | where |",
    "| --- | --- | ---: | --- |",
  );
  for (const pair of kindOnly) say(`| ${code(pair.old)} | ${code(pair.new)} | ${String(pair.nodes)} | ${where(pair.scopes)} |`);
  say("");

  // ── restated ────────────────────────────────────────────────────────────────────────────
  const restated = pairs(of("restated"));
  say(
    `## The role said the kind again (${String(restated.length)} distinct, ${String(counts.get("restated")?.nodes ?? 0)} nodes)`,
    "",
    "One end of the old name was the kind in the author's words (`pts`, `geo`, `mat`, `cam`, `lvl`). That end goes; what is left is the role.",
    "",
    "| old | new | nodes | where |",
    "| --- | --- | ---: | --- |",
  );
  for (const pair of restated) say(`| ${code(pair.old)} | ${code(pair.new)} | ${String(pair.nodes)} | ${where(pair.scopes)} |`);
  say("");

  // ── outward ─────────────────────────────────────────────────────────────────────────────
  const outward = of("outward");
  if (outward.length > 0) {
    say(
      `## A component that reads the document around it (${String(outward.length)} references)`,
      "",
      "Not a rename of a node in the scope. The component's graph names a node that is not in it, which only resolves in the document the component was saved from. Renaming that node there has to move this reference too, in every file that embeds the component, or the home document stops doing it. Elsewhere the reference names nothing today and names nothing after. Found by the equivalence check; worth a look on its own, because a starter component that only works beside two particular LFOs is probably not what was meant.",
      "",
      "| component | reads | becomes | why |",
      "| --- | --- | --- | --- |",
    );
    for (const entry of outward) say(`| ${short(entry.scope)} | ${code(entry.old)} | ${code(entry.new)} | ${entry.reason ?? ""} |`);
    say("");
  }

  // ── the kind table's less obvious words ─────────────────────────────────────────────────
  say(
    "## Six kind words to look at",
    "",
    "The kind table's less obvious words, with what the shipped names on them become.",
    "",
    "| kind | node type | shipped names | for instance |",
    "| --- | --- | ---: | --- |",
  );
  for (const kind of KINDS_TO_SHOW) {
    const types = Object.entries(NODE_KINDS).filter(([, value]) => value === kind).map(([type]) => type);
    const entries = map.entries.filter((entry) => entry.kind === kind);
    const nodes = entries.reduce((sum, entry) => sum + entry.occurrences, 0);
    say(`| ${code(kind)} | ${types.map(code).join(", ")} | ${String(nodes)} | ${entries.length === 0 ? "none shipped" : samples(entries)} |`);
  }
  say("");

  // ── left alone ──────────────────────────────────────────────────────────────────────────
  const reviewed = new Set<RenameRule>(REVIEWED_RULES);
  const shortRoles = pairs(map.entries.filter((entry) => !reviewed.has(entry.rule)))
    .filter((pair) => pair.new.length - pair.kind.length - 1 === 3);
  say(
    "## Left as the author wrote them",
    "",
    `${String(shortRoles.length)} distinct names end with a three-letter role that no rule or person touched. Most are words (\`sum\`, \`mix\`, \`key\`, \`rim\`, \`sky\`, \`eye\`). These are the abbreviations among them, kept because they are the author's and read in place; say so if any should be spelled out:`,
    "",
    shortRoles
      .filter((pair) => ABBREVIATIONS.has(pair.new.slice(pair.kind.length + 1)))
      .map((pair) => `${code(pair.new)} (${where(pair.scopes)})`)
      .join(", "),
    "",
  );
  return `${lines.join("\n")}\n`;
}

/** Three-letter roles that are abbreviations rather than words: shown to the reviewer, not changed. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "src", "lvl", "env", "fig", "cyc", "occ", "gen", "neb", "ctl", "err", "seg", "ang", "sat", "lum", "dof", "taa", "led", "dir",
]);
