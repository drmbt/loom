import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditedGraphs } from "../node-name-audit.ts";
import { applyRenameMap } from "./apply-rename-map.ts";
import { auditRenameMap, buildRenameMap, renamesByScope, scopeOf, shippedDocuments, type ShippedDocument } from "./rename-map.ts";
import { rewriteDocumentSource, rewritePage, rewriteTest, type NameTable, type Rewritten } from "./source-rewrite.ts";

/**
 * THE APPLY TOOL for the naming sweep (T1593b). It rewrites the text that builds and
 * describes the shipped documents: the document sources, the pages beside the examples,
 * the README index, and the tests that name nodes.
 *
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/apply-rename.ts
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/apply-rename.ts --files
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/apply-rename.ts --notes
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/apply-rename.ts --build-in <dir>
 *   node --import ./src/tooling/alias-hooks.ts src/examples/rename/apply-rename.ts --only E45
 *
 * **Without `--write` it writes nothing in the tree.** That is a DRY RUN: it rewrites every
 * file in memory and prints what would change, per directory. `--files` lists every file;
 * `--notes` prints what a person has to do by hand, with line numbers.
 *
 * `--build-in <dir>` is the dry run that proves something. It puts the rewritten example
 * sources in `<dir>/overlay`, builds every example and starter component from them into
 * `<dir>/built` (`overlay-hooks.ts`; the tree is not touched), and compares each built file
 * with the SAME file renamed in memory by the map. Equal means the rewritten source builds
 * exactly the renamed document. `<dir>` must be outside the shipped tree.
 *
 * `--only <text>[,<text>…]` does one batch: the scopes whose name contains a text
 * (`components/Bloom`, `on-nothing`; an E-number such as `E2` names that one example
 * exactly), widened to every scope that shares a source file with
 * one of them, because a file cannot be half renamed. It says what it widened to. Names of
 * every other scope are left exactly as they are, in every file.
 *
 * `--written` says the sources on disk are already the rewritten ones (after `--write`, and
 * after the hand work `--notes` listed). With `--build-in` it then builds from the tree as
 * it stands and tries every document, which is how a finished batch is proved before it is
 * regenerated.
 *
 * `--write` is phase 2b and is not to be run before the map is approved. It writes the
 * sources, pages and tests, and the furnace and on-nothing documents themselves (those are
 * built from files this checkout does not always have, so they are renamed in place
 * through the save path's serialiser). It does NOT write `examples/**.loom.json`: those are
 * regenerated from their sources, one `--only` at a time.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const flag = (name: string): boolean => process.argv.includes(name);
const valueOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const documents = shippedDocuments();
const map = buildRenameMap(documents);
const unsound = auditRenameMap(map, documents);
if (unsound.length > 0) {
  console.error(`The rename map is not sound; nothing was done.\n  ${unsound.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
const byScope = renamesByScope(map);

// ── what each scope renames, and which words in it are also ids ────────────────────────────
const idsIn = new Map<string, Set<string>>();
const namesIn = new Map<string, Set<string>>();
const embeddedBy = new Map<string, Set<string>>();
for (const document of documents) {
  for (const graph of auditedGraphs(document.text)) {
    const scope = scopeOf(document.path, graph);
    const ids = idsIn.get(scope) ?? new Set<string>();
    idsIn.set(scope, ids);
    for (const node of graph.nodes) ids.add(node.id);
    const names = namesIn.get(scope) ?? new Set<string>();
    namesIn.set(scope, names);
    for (const node of graph.nodes) if (node.name !== undefined) names.add(node.name);
    if (graph.component !== null) embeddedBy.set(document.path, (embeddedBy.get(document.path) ?? new Set<string>()).add(scope));
  }
}

/** The scopes of this batch, or `undefined` for all of them. Set once the sources are known. */
let batch: ReadonlySet<string> | undefined;

function tableFor(scopes: Iterable<string>): NameTable {
  const seen = new Map<string, Set<string>>();
  const seenTyped = new Map<string, Set<string>>();
  const outside = new Set<string>();
  const ids = new Set<string>();
  for (const scope of scopes) {
    for (const entry of map.entries) {
      if (entry.scope !== scope) continue;
      seen.set(entry.old, (seen.get(entry.old) ?? new Set<string>()).add(entry.new));
      const key = `${entry.type}\n${entry.old}`;
      seenTyped.set(key, (seenTyped.get(key) ?? new Set<string>()).add(entry.new));
      // A name some scope OUTSIDE the batch renames is not this batch's to move.
      if (batch !== undefined && !batch.has(scope)) outside.add(entry.old).add(key);
    }
    // A name this scope holds and does NOT rename is an answer too: it stays. A file that
    // builds this scope and one that renames the same word cannot rewrite a bare reference.
    for (const name of namesIn.get(scope) ?? []) {
      if (!map.entries.some((entry) => entry.scope === scope && entry.old === name)) seen.set(name, (seen.get(name) ?? new Set<string>()).add(name));
    }
    // (ids are read from every scope below, not from this one alone)
  }
  const names = new Map<string, string>();
  const clash = new Set<string>();
  for (const [old, news] of seen) {
    if (news.size > 1) clash.add(old);
    else if (!news.has(old) && !outside.has(old)) names.set(old, [...news][0] ?? old);
  }
  const typed = new Map([...seenTyped].flatMap(([key, news]) => (news.size === 1 && !outside.has(key) ? [[key, [...news][0] ?? ""] as const] : [])));
  for (const scopeIds of idsIn.values()) for (const id of scopeIds) ids.add(id);
  return { names, typed, clash, idsToo: new Set([...names.keys()].filter((name) => ids.has(name))) };
}

// ── the files ──────────────────────────────────────────────────────────────────────────────
function walk(directory: string, keep: (path: string) => boolean): string[] {
  const found: string[] = [];
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return found;
  for (const name of readdirSync(absolute).sort()) {
    const path = `${directory}/${name}`;
    if (statSync(join(root, path)).isDirectory()) found.push(...walk(path, keep));
    else if (keep(path)) found.push(path);
  }
  return found;
}
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const isTest = (path: string): boolean => /\.(test|spec)\.tsx?$/.test(path);
const isSource = (path: string): boolean => /\.tsx?$/.test(path) && !isTest(path);

interface Example {
  readonly document: ShippedDocument;
  readonly stem: string;
  readonly slug: string;
}
const examples: Example[] = documents.filter((document) => document.path.startsWith("examples/")).map((document) => ({
  document,
  stem: basename(document.path, ".loom.json"),
  slug: String((JSON.parse(document.text) as { projectId?: unknown }).projectId ?? "").replace(/^(example|component)-/, ""),
}));
const isComponentHost = (example: Example): boolean => example.document.path.startsWith("examples/components/");

/**
 * Which scopes a source file builds. Asked of the modules themselves, not guessed from
 * their text: a document a module EXPORTS is one it builds, whatever its slug is computed
 * from, and a starter component is cut out of the host document its spec names. A module
 * that another imports builds whatever the importer builds.
 */
const sourceScopes = new Map<string, Set<string>>();
const documentSources = walk("src/examples/documents", isSource).filter((path) => !path.endsWith("/builders.ts"));
const starterSource = "src/examples/starter-components.ts";
const exportsOf = new Map<string, string[]>();
const moduleOfDocument = new Map<unknown, string>();
const pathOfProject = new Map(examples.map((example) => [String((JSON.parse(example.document.text) as { projectId?: unknown }).projectId), example.document.path]));
const isDocument = (value: unknown): value is { projectId: string } =>
  value !== null && typeof value === "object" && typeof (value as { projectId?: unknown }).projectId === "string" && "graph" in value;

for (const path of [...documentSources, starterSource]) {
  const exported = (await import(pathToFileURL(join(root, path)).href)) as Record<string, unknown>;
  const scopes = new Set<string>();
  const names: string[] = [];
  for (const [name, value] of Object.entries(exported)) {
    if (!isDocument(value)) continue;
    moduleOfDocument.set(value, path);
    names.push(name);
    const built = pathOfProject.get(value.projectId);
    if (built !== undefined && !built.startsWith("examples/components/")) scopes.add(built);
  }
  sourceScopes.set(path, scopes);
  exportsOf.set(path, names);
}
const starter = (await import(pathToFileURL(join(root, starterSource)).href)) as { STARTER_COMPONENT_SPECS: ReadonlyArray<{ componentId: string; host: unknown }> };
for (const spec of starter.STARTER_COMPONENT_SPECS) {
  const host = examples.find((example) => isComponentHost(example) && example.slug.toLowerCase() === spec.componentId.toLowerCase());
  if (host === undefined) continue;
  const built = [host.document.path, ...[...(embeddedBy.get(host.document.path) ?? [])].filter((scope) => scope.startsWith(`component ${spec.componentId}@`))];
  for (const module of [moduleOfDocument.get(spec.host) ?? starterSource, starterSource]) {
    const scopes = sourceScopes.get(module) ?? new Set<string>();
    sourceScopes.set(module, scopes);
    for (const scope of built) scopes.add(scope);
  }
}
// A module beside the documents that one of them imports builds what the importer builds.
// (Only one that writes a label or reads a node: a shared constant or a shader names nothing.)
const namesSomething = (path: string): boolean => /\blabel\s*:|op\(/.test(read(path));
const helpers = [...walk("src/examples", (path) => isSource(path) && dirname(path) === "src/examples" && path !== starterSource), ...documentSources].filter(namesSomething);
for (let pass = 0; pass < 2; pass += 1) {
  for (const helper of helpers) {
    const imported = new RegExp(`from "[^"]*/${basename(helper).replace(/\./g, "\\.")}"`);
    const scopes = sourceScopes.get(helper) ?? new Set<string>();
    for (const path of [...documentSources, starterSource]) {
      if (path === helper || !imported.test(read(path))) continue;
      for (const scope of sourceScopes.get(path) ?? []) scopes.add(scope);
    }
    sourceScopes.set(helper, scopes);
  }
}
for (const project of ["furnace", "on-nothing"]) {
  for (const path of walk(`src/projects/${project}`, isSource)) sourceScopes.set(path, new Set([`projects/${project}`]));
}

// ── one batch ──────────────────────────────────────────────────────────────────────────────
const only = valueOf("--only");
if (only !== undefined) {
  const every = [...new Set(map.entries.map((entry) => entry.scope))];
  // Several at once, by comma. An E-number names ONE example, exactly, as it does for the
  // examples build: `E2` is not E20 to E29.
  const asks = only.split(",").map((ask) => ask.trim()).filter((ask) => ask !== "");
  const chosen = new Set(every.filter((scope) => asks.some((ask) => (/^E[0-9]+$/.test(ask) ? scope.startsWith(`examples/${ask}-`) : scope.includes(ask)))));
  if (chosen.size === 0) throw new Error(`--only ${only} matches no scope that renames anything.`);
  const asked = chosen.size;
  for (let grew = true; grew; ) {
    grew = false;
    for (const scopes of sourceScopes.values()) {
      if (![...scopes].some((scope) => chosen.has(scope))) continue;
      for (const scope of scopes) {
        if (chosen.has(scope)) continue;
        chosen.add(scope);
        grew = true;
      }
    }
  }
  batch = chosen;
  console.log(`ONLY ${only}: ${String(asked)} scopes asked for, ${String(chosen.size)} with the ones that share a source file: ${[...chosen].sort().map((scope) => scope.replace(/^examples\//, "").replace(/\.loom\.json$/, "")).join(", ")}`);
}

/** The renames this run applies: all of them, or the batch's. */
const applying = batch === undefined ? byScope : new Map([...byScope].filter(([scope]) => batch?.has(scope) === true));

/** Which scopes a test names nodes of: the documents it spells, by file name, slug or exported constant. */
function testScopes(path: string, text: string): Set<string> {
  const scopes = new Set<string>();
  const project = /^src\/projects\/([^/]+)\//.exec(path)?.[1];
  if (project !== undefined) scopes.add(`projects/${project}`);
  for (const example of examples) {
    // A starter component's file is named for the component (`Bloom`), which is also a word:
    // it has to be spelled as a file. And a host document is not found by the constant that
    // exports it, because the example built from the same constant is a different document.
    const host = isComponentHost(example);
    const named = host ? text.includes(`${example.stem}.loom.json`) : text.includes(example.stem) || text.includes(`"${example.slug}"`);
    const imported = !host && [...sourceScopes].some(([source, built]) => built.has(example.document.path) && (exportsOf.get(source) ?? []).some((name) => new RegExp(`\\b${name}\\b`).test(text)));
    if (!named && !imported) continue;
    scopes.add(example.document.path);
    for (const scope of embeddedBy.get(example.document.path) ?? []) scopes.add(scope);
  }
  return scopes;
}

// ── rewrite everything in memory ───────────────────────────────────────────────────────────
interface Planned {
  readonly path: string;
  readonly kind: "source" | "page" | "test" | "document";
  readonly before: string;
  readonly after: Rewritten;
}
const planned: Planned[] = [];
const spelledIn = new Map<string, Set<string>>();
/** Does a file that covers these scopes belong to the batch? Always, when there is no batch. */
const inBatch = (scopes: Iterable<string>): boolean => batch === undefined || [...scopes].some((scope) => batch?.has(scope) === true);

for (const [path, scopes] of [...sourceScopes].sort()) {
  if (scopes.size === 0 || !existsSync(join(root, path)) || !inBatch(scopes)) continue;
  const before = read(path);
  const after = rewriteDocumentSource(path, before, tableFor(scopes));
  planned.push({ path, kind: "source", before, after });
  for (const scope of scopes) for (const name of after.spelled) spelledIn.set(scope, (spelledIn.get(scope) ?? new Set<string>()).add(name));
}
for (const example of examples) {
  const page = example.document.path.replace(/\.loom\.json$/, ".md");
  const covers = [example.document.path, ...(embeddedBy.get(example.document.path) ?? [])];
  if (!existsSync(join(root, page)) || !inBatch(covers)) continue;
  const before = read(page);
  planned.push({ path: page, kind: "page", before, after: rewritePage(before, tableFor(covers)) });
}
// The README index is one row per example: each row is read under its own example's names.
if (existsSync(join(root, "examples/README.md"))) {
  const before = read("examples/README.md");
  let changed = 0;
  const notes: string[] = [];
  const lines = before.split("\n").map((line, index) => {
    const row = examples.filter((example) => line.includes(`${example.stem}.md`) || line.includes(`${example.stem}.loom.json`));
    if (row.length === 0) return line;
    const rewritten = rewritePage(line, tableFor(row.flatMap((example) => [example.document.path, ...(embeddedBy.get(example.document.path) ?? [])])));
    changed += rewritten.changed;
    notes.push(...rewritten.notes.map((note) => note.replace(/^line 1/, `line ${String(index + 1)}`)));
    return rewritten.text;
  });
  planned.push({ path: "examples/README.md", kind: "page", before, after: { text: lines.join("\n"), changed, spelled: new Set(), notes } });
}
for (const path of walk("src", isTest)) {
  if (path.startsWith("src/examples/rename/") || path.startsWith("src/projects/sentinel-bot/")) continue;
  // The naming gate spells OLD names on purpose: its ledger's keys, and the habit it describes.
  if (path === "src/examples/node-names.test.ts") continue;
  const before = read(path);
  const scopes = testScopes(path, before);
  if (scopes.size === 0 || !inBatch(scopes)) continue;
  planned.push({ path, kind: "test", before, after: rewriteTest(path, before, tableFor(scopes)) });
}
// The project documents are renamed in place (see the header); listed here like any other file.
// A batch reaches a project document it does not name when that document embeds a component
// of the batch: a component is one definition wherever it is embedded, and stays one.
for (const document of documents) {
  if (!document.path.startsWith("projects/")) continue;
  const after = applyRenameMap(document.path, document.text, applying);
  if (batch !== undefined && after.text === document.text) continue;
  planned.push({ path: document.path, kind: "document", before: document.text, after: { text: after.text, changed: after.applied.length, spelled: new Set(), notes: [] } });
}

// ── report ─────────────────────────────────────────────────────────────────────────────────
const touched = planned.filter((file) => file.after.text !== file.before);
const directoryOf = (path: string): string => (path.startsWith("src/projects/") ? path.split("/").slice(0, 3).join("/") : path.startsWith("projects/") ? path.split("/").slice(0, 2).join("/") : dirname(path));
const perDirectory = new Map<string, { files: number; changes: number }>();
for (const file of touched) {
  const key = `${file.kind.padEnd(8)} ${directoryOf(file.path)}/`;
  const before = perDirectory.get(key) ?? { files: 0, changes: 0 };
  perDirectory.set(key, { files: before.files + 1, changes: before.changes + file.after.changed });
}
console.log(`${flag("--write") ? "WRITING" : "DRY RUN: nothing is written."}  ${String(touched.length)} files would change (${String(planned.length)} read), ${String(touched.reduce((sum, file) => sum + file.after.changed, 0))} spellings.`);
for (const [key, count] of [...perDirectory].sort()) console.log(`  ${key.padEnd(48)} ${String(count.files).padStart(4)} files ${String(count.changes).padStart(6)} changes`);
console.log(`  regenerated, not written: examples/ ${String(examples.filter((example) => !isComponentHost(example)).length)} documents, examples/components/ ${String(examples.filter(isComponentHost).length)}.`);
if (flag("--files")) for (const file of touched) console.log(`  ${file.kind.padEnd(8)} ${String(file.after.changed).padStart(5)}  ${file.path}`);

// What no source spells: a name the map renames that no file of its scope writes as a name.
const unspelled = new Map<string, string[]>();
for (const entry of map.entries) {
  if (batch !== undefined && !batch.has(entry.scope)) continue;
  if (entry.rule === "outward" || spelledIn.get(entry.scope)?.has(entry.old) === true) continue;
  unspelled.set(entry.scope, [...(unspelled.get(entry.scope) ?? []), entry.old]);
}
const noteCount = touched.reduce((sum, file) => sum + file.after.notes.length, 0) + planned.filter((file) => file.after.text === file.before).reduce((sum, file) => sum + file.after.notes.length, 0);
const unspelledCount = [...unspelled.values()].reduce((sum, names) => sum + names.length, 0);
console.log(`BY HAND: ${String(unspelledCount)} names in ${String(unspelled.size)} scopes are not written as a name in any source (built by code), and ${String(noteCount)} notes. --notes lists both.`);
if (flag("--notes")) {
  for (const [scope, names] of [...unspelled].sort()) console.log(`  not spelled  ${scope}: ${String(names.length)} names, e.g. ${names.slice(0, 6).join(", ")}`);
  for (const file of planned) for (const note of file.after.notes) console.log(`  note  ${file.path} ${note}`);
}

// ── the proof: build from the rewritten sources, compare with the map applied in memory ────
const buildIn = valueOf("--build-in");
if (buildIn !== undefined) {
  if (join(buildIn, "x").startsWith(join(root, "examples")) || join(buildIn, "x").startsWith(join(root, "src")) || join(buildIn, "x").startsWith(join(root, "projects"))) {
    throw new Error("--build-in must be outside the shipped tree.");
  }
  const overlay = join(buildIn, "overlay");
  const built = join(buildIn, "built");
  rmSync(overlay, { recursive: true, force: true });
  rmSync(built, { recursive: true, force: true });
  // Only a source whose every name is WRITTEN is tried. One that builds names in code is
  // half rewritten by this tool and throws or builds nonsense until a person finishes it.
  // …and a file that shares a scope with such a source is not tried either, to a fixpoint:
  // a document is only built when EVERY source that builds it is used rewritten.
  const byHand = new Set(flag("--written") ? [] : unspelled.keys());
  for (let grew = true; grew; ) {
    grew = false;
    for (const scopes of sourceScopes.values()) {
      if (![...scopes].some((scope) => byHand.has(scope))) continue;
      for (const scope of scopes) {
        if (byHand.has(scope)) continue;
        byHand.add(scope);
        grew = true;
      }
    }
  }
  // A document nothing renames is tried too: it must come out of the build untouched.
  const tried = new Set(examples.map((example) => example.document.path).filter((scope) => !byHand.has(scope)));
  for (const file of touched) {
    const scopes = [...(sourceScopes.get(file.path) ?? [])];
    if (file.kind !== "source" || !file.path.startsWith("src/examples/") || scopes.some((scope) => byHand.has(scope))) continue;
    mkdirSync(dirname(join(overlay, file.path)), { recursive: true });
    writeFileSync(join(overlay, file.path), file.after.text);
  }
  execFileSync(
    process.execPath,
    ["--import", "./src/tooling/alias-hooks.ts", "--import", "./src/examples/rename/overlay-hooks.ts", "src/examples/build-examples.ts", "--out", built],
    { cwd: root, env: { ...process.env, LOOM_SOURCE_OVERLAY: overlay }, stdio: ["ignore", "ignore", "inherit"] },
  );
  let same = 0;
  const untriedNames: string[] = [];
  const notesOnly: string[] = [];
  const different: string[] = [];
  for (const example of examples) {
    if (!tried.has(example.document.path)) {
      untriedNames.push(example.stem);
      continue;
    }
    const expected = applyRenameMap(example.document.path, example.document.text, applying).text;
    const builtPath = join(built, example.document.path.replace(/^examples\//, ""));
    const actual = existsSync(builtPath) ? readFileSync(builtPath, "utf8") : "";
    if (actual === expected) same += 1;
    else if (withoutNotes(actual) === withoutNotes(expected)) notesOnly.push(example.document.path);
    else different.push(`${example.document.path}: ${firstDifference(withoutNotes(expected), withoutNotes(actual))}`);
  }
  console.log(`BUILT FROM THE REWRITTEN SOURCES: ${String(same)} of ${String(examples.length - untriedNames.length)} documents tried are byte for byte the renamed document.`);
  console.log(`  ${String(untriedNames.length)} not tried, because a source that builds them makes names in code: ${untriedNames.join(", ")}`);
  if (notesOnly.length > 0) console.log(`  ${String(notesOnly.length)} more are the same but for the text of a note, which the rewritten source updates and a rename in memory does not: ${notesOnly.join(", ")}`);
  for (const line of different) console.log(`  differs  ${line}`);
}

/** A document without the text of its notes. A note is prose: it is compared by eye, not by byte. */
function withoutNotes(text: string): string {
  if (text === "") return text;
  const file = JSON.parse(text) as { graph?: { nodes?: Record<string, { type?: string; parameters?: unknown }> } };
  for (const node of Object.values(file.graph?.nodes ?? {})) if (node.type === "annotate") node.parameters = {};
  return JSON.stringify(file);
}

/** Where two documents first differ, as `path: expected / built`. */
function firstDifference(expected: string, actual: string): string {
  if (actual === "") return "not built";
  const walkBoth = (left: unknown, right: unknown, path: string): string | undefined => {
    if (JSON.stringify(left) === JSON.stringify(right)) return undefined;
    if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])) {
        const found = walkBoth(leftRecord[key], rightRecord[key], `${path}.${key}`);
        if (found !== undefined) return found;
      }
    }
    return `${path}: expected ${String(JSON.stringify(left)).slice(0, 80)}, built ${String(JSON.stringify(right)).slice(0, 80)}`;
  };
  return walkBoth(JSON.parse(expected), JSON.parse(actual), "") ?? "the same data in different bytes";
}

if (flag("--write")) {
  for (const file of touched) writeFileSync(join(root, file.path), file.after.text);
  console.log(`wrote ${String(touched.length)} files. Now regenerate the examples, one --only at a time (docs/node-naming-2026-10-05.md, section 10).`);
}
