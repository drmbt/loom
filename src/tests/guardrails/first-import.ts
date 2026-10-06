import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * §V1028 / B246 — WHAT THE TWO FIRST-MODULE GATES SHARE: starting a fresh `node` with a given
 * module as the first thing it loads, and reading a script's own import list.
 *
 * ## The failure this exists for
 *
 * B246: every plain-node entry point died at import with
 * `ReferenceError: Cannot access 'NO_MORPHS' before initialization`. One module read an
 * imported constant at module scope, across an import cycle, and whether that constant had
 * been initialised yet depended on WHICH MODULE THE PROCESS LOADED FIRST. Vitest never saw
 * it — a test file loads other modules first, and so did every test in the suite — while
 * `pnpm helper`, the examples build and every project render script were dead on `main`.
 *
 * So the subject of these gates is not a function and cannot be reached by importing it into
 * a test: the test process is exactly the wrong process. Each subject gets its OWN fresh
 * `node`, with the repo's loader (`src/tooling/alias-hooks.ts`) and nothing else, the way a
 * person runs a script — and the assertion is that it exits 0.
 *
 * ## Why a fresh process and not a worker thread
 *
 * Both were measured over the 251 modules of the general form, four at a time: 5.9 s of wall
 * (23 s summed) in processes against 3.4 s (13 s summed) in threads. The process is what is
 * kept, because it IS the thing that failed — the failure message prints a command a person
 * can paste — and a module that hangs at import can be killed without taking the test runner
 * with it. The difference decides nothing: the general form is too dear for the commit gate
 * either way.
 */

export const ROOT = resolve(import.meta.dirname, "../../..");

/** The loader every plain-node script in this repo starts with (`alias-hooks.ts`'s docblock). */
const LOADER = "./src/tooling/alias-hooks.ts";

/**
 * A module that takes this long to import has started WORK at import — a server, a render —
 * which is its own failure. Measured: the slowest clean import takes about a second, cold,
 * on a loaded machine.
 */
const TIMEOUT_MS = 60_000;

/** One fresh process: these modules, imported in this order, before anything else. */
export interface FirstImport {
  /** What a report calls it: the entry point this stands for. */
  readonly label: string;
  /** Repo-relative (`src/…`). One for a module; a script's own imports for a script. */
  readonly modules: readonly string[];
}

export interface FirstImportRun {
  readonly subject: FirstImport;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stderr: string;
}

/** Static imports, so the order is the one a file with these imports would be evaluated in. */
function entrySource(subject: FirstImport): string {
  return subject.modules.map((module) => `import ${JSON.stringify(`./${module}`)};`).join(" ");
}

function nodeArguments(subject: FirstImport): string[] {
  return ["--import", LOADER, "--input-type=module", "-e", entrySource(subject)];
}

function importFirst(subject: FirstImport): Promise<FirstImportRun> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, nodeArguments(subject), { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", (error) => (stderr += `\n${String(error)}`));
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      settle({ subject, status, signal, timedOut, stderr });
    });
  });
}

/**
 * Every subject, each in its own process, at most `concurrency` alive at once. Bounded on
 * purpose: this machine is shared, and a gate that starts one process per subject all at
 * once is the load it would then be measured under.
 */
export async function importEachFirst(subjects: readonly FirstImport[], concurrency: number): Promise<FirstImportRun[]> {
  const runs = new Array<FirstImportRun>(subjects.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let at = next++; at < subjects.length; at = next++) {
      const subject = subjects[at];
      if (subject !== undefined) runs[at] = await importFirst(subject);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, subjects.length) }, lane));
  return runs;
}

/** `null` when the import was clean; otherwise the whole story, for an assertion message. */
export function firstImportFailure(run: FirstImportRun): string | null {
  if (run.status === 0 && !run.timedOut) return null;
  const how = run.timedOut
    ? `did not finish within ${TIMEOUT_MS / 1000} s and was killed — it starts work at import`
    : `exited ${run.status === null ? `on ${String(run.signal)}` : String(run.status)}`;
  return [
    `${run.subject.label} does not import cleanly as the FIRST module of a fresh node process: it ${how}.`,
    "",
    `  repro:  node ${nodeArguments(run.subject).map((part) => (/[\s"']/.test(part) ? `'${part}'` : part)).join(" ")}`,
    "",
    "  stderr of that process:",
    ...(run.stderr.trim() === "" ? ["    (empty)"] : run.stderr.trimEnd().split("\n").map((line) => `    ${line}`)),
    "",
    "No vitest file can see this: a test loads other modules first, and here the order is the bug",
    "(§V1028, B246). If the error is `Cannot access '…' before initialization`, a module reads an",
    "imported value at module scope across an import cycle. Move the value DOWN, into the module",
    "both sides already import (B246 moved NO_MORPHS into parameters/resolve.ts), or break the cycle.",
  ].join("\n");
}

/** `node --import ./src/tooling/alias-hooks.ts <script>`: how every plain-node script here is run. */
const INVOCATION = /node\s+--import\s+\.\/src\/tooling\/alias-hooks\.ts\s+(?:\.\/)?(src\/[\w./-]+\.ts)\b/g;

/** The scripts under `src/` that a text tells its reader to run under plain node. */
export function scriptsNamedIn(text: string): string[] {
  return [...text.matchAll(INVOCATION)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** `["@domain/", "<root>/src/domain/"]`, longest prefix first — the table the loader reads, read where it reads it. */
const ALIASES: ReadonlyArray<readonly [string, string]> = Object.entries(
  (
    JSON.parse(readFileSync(join(ROOT, "tsconfig.app.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, readonly string[]> };
    }
  ).compilerOptions.paths,
)
  .flatMap(([pattern, targets]) =>
    targets[0] === undefined ? [] : [[pattern.replace(/\*$/, ""), resolve(ROOT, targets[0].replace(/\*$/, ""))] as const],
  )
  .sort((left, right) => right[0].length - left[0].length);

/**
 * A script's own imports of THIS repo's modules, in source order, repo-relative — what
 * stands in for a script that cannot be imported because it runs on import.
 *
 * Importing these in order evaluates the same modules in the same order the script would,
 * and stops short of the script's body. `import type` is left out because the loader erases
 * it; `import { type X }` is KEPT because the loader keeps it, as a bare module load
 * (measured — it is why the lint zone refuses both spellings). Packages and `node:` builtins
 * are left out: they take no part in the order our own modules initialise in.
 */
export function ownImports(script: string): string[] {
  const path = join(ROOT, script);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
    const target = specifier.startsWith(".")
      ? resolve(dirname(path), specifier)
      : alias === undefined
        ? undefined
        : join(alias[1], specifier.slice(alias[0].length));
    if (target !== undefined) found.push(relative(ROOT, target).split(sep).join("/"));
  }
  return found;
}

/** Comments out, so a tell-tale is looked for in what the file DOES and not in what it says. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * A module that reads `process.argv` is a SCRIPT: it is meant to be run, and importing it
 * runs it. Neither gate ever evaluates one whole unless it is listed, by name, as guarded.
 *
 * This is not caution for its own sake. `src/examples/build-examples.ts` and
 * `build-thumbnails.ts` have no main guard: importing one rewrites every shipped example,
 * importing the other starts re-rendering every thumbnail. That is an unscoped regen, which
 * in a shared tree sweeps other sessions' in-flight documents (§B197).
 */
export function readsProcessArguments(script: string): boolean {
  return /\bprocess\s*\.\s*argv\b/.test(withoutComments(readFileSync(join(ROOT, script), "utf8")));
}
