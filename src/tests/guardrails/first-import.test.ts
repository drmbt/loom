import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ROOT,
  firstImportFailure,
  importEachFirst,
  ownImports,
  readsProcessArguments,
  scriptsNamedIn,
  type FirstImport,
  type FirstImportRun,
} from "./first-import.ts";

/**
 * §V1028 / B246 — EVERY PLAIN-NODE ENTRY POINT IMPORTS CLEANLY AS THE FIRST MODULE OF A FRESH
 * PROCESS.
 *
 * B246 is in `first-import.ts`: an imported constant read at module scope across an import
 * cycle, uninitialised or not depending on which module the process loaded FIRST. Vitest
 * loads other modules first, so the suite was green while `pnpm helper`, the examples build
 * and every project render script died on their first line. The lint zone in
 * `eslint.config.js` forbids the edge that closed that cycle; this gate holds the
 * consequence for whatever cycle comes next, by doing what the bug report did: start a fresh
 * `node` on each entry point and require exit 0.
 *
 * ## The list is derived (§V957's lesson, applied to entry points)
 *
 * A hand list of entry points is the list B246 would have been missing from. So:
 *
 *  - SCRIPTS are every `src/…` file some text tells a person to run under the loader — the
 *    `package.json` scripts, `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/`, and the usage
 *    line each script carries in its own docblock — plus every project's `render.ts` and
 *    `build.ts`, found by PATTERN: a project added tomorrow is covered the day it lands.
 *  - A script is NEVER evaluated whole, because most of them run on import (they read
 *    `process.argv`, a GLB, or rewrite `examples/`). What is imported instead is the script's
 *    own import list, in its own order, in one process: the same modules initialise in the
 *    same order, and the body never runs. The exception is a script listed in
 *    `GUARDED_SCRIPTS`, whose body is behind a main guard.
 *  - MODULE_ROOTS is the short hand list that is left: the library modules B246's fix was
 *    checked on, which no script names. With the bug put back, render-harness.ts,
 *    flatten.ts and morph-index.ts die; the two under `parameters/` are the other end of the
 *    cycle, the order in which it happened to work.
 *
 * ## Why this is on `test:gates`, and what it costs
 *
 * It finds its subjects by walking the tree, so no dependency selector reaches it (§V957).
 * Sixteen processes when it landed, at most three alive at once. Measured on 14 cores: 1.7 s
 * at a load average of 13, and 3.3–4.4 s at a load average of 30, which is the condition it
 * is usually run in.
 *
 * Every subject is a process, so MODULE_ROOTS STAYS SHORT: a library module earns a line by
 * being somewhere a plain-node consumer really starts, not by being importable. The general
 * form — every module under src/domain, src/compiler and src/runtime, 249 processes — is
 * `first-import-all.test.ts`, and is deliberately NOT on the commit gate.
 */

/** Library modules a plain-node consumer starts from: the ones B246's fix was checked on. */
const MODULE_ROOTS: Readonly<Record<string, string>> = {
  "src/tests/headless/render-harness.ts":
    "what every project render script and every headless render goes through — the repro B246 was filed with",
  "src/compiler/flatten.ts": "the compiler's way into the components and parameters layers",
  "src/domain/parameters/resolve.ts": "the one parameter read path, and the module B246's cycle ran through",
  "src/domain/parameters/node-references.ts": "the module whose module-scope read died",
  "src/domain/presets/morph-index.ts": "the module that, loaded first, left the constant uninitialised",
};

/**
 * Scripts whose body is behind a main guard, so the file itself can be the first module.
 * Checked both ways below: an entry must still be a script some text names, and must still
 * carry the guard.
 */
const GUARDED_SCRIPTS: Readonly<Record<string, string>> = {
  "src/mcp/serve.ts":
    "what the `helper` package script runs. Everything it does is under `if (process.argv[1]?.endsWith(\"serve.ts\") === true)`, so importing it opens no socket and builds no surface",
};

/** How many fresh processes are alive at once. See `importEachFirst`. */
const CONCURRENCY = 3;

function filesUnder(directory: string, keep: RegExp): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...filesUnder(path, keep));
    } else if (keep.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** Every text that tells somebody to run a script. */
const INSTRUCTIONS: readonly string[] = [
  ...["package.json", "CLAUDE.md", "AGENTS.md", "README.md"].map((name) => join(ROOT, name)).filter((path) => existsSync(path)),
  ...filesUnder(join(ROOT, "docs"), /\.md$/),
  ...filesUnder(join(ROOT, "src"), /\.(ts|tsx|md)$/),
];

const namedScripts = INSTRUCTIONS.flatMap((path) => scriptsNamedIn(readFileSync(path, "utf8")));

/** `src/projects/<name>/{render,build}.ts`, for every project there is. No project is named here. */
const projectScripts = (existsSync(join(ROOT, "src/projects")) ? readdirSync(join(ROOT, "src/projects"), { withFileTypes: true }) : [])
  .filter((entry) => entry.isDirectory())
  .flatMap((project) => ["render.ts", "build.ts"].map((script) => join(ROOT, "src/projects", project.name, script)))
  .map((path) => relative(ROOT, path).split("\\").join("/"));

// A doc may name a script that has since been deleted; that is the doc's drift, not an entry point.
const scripts = [...new Set([...namedScripts, ...projectScripts])].filter((script) => existsSync(join(ROOT, script))).sort();

const subjects: FirstImport[] = [
  ...Object.keys(MODULE_ROOTS).map((module) => ({ label: module, modules: [module] })),
  ...scripts.flatMap((script): FirstImport[] => {
    if (GUARDED_SCRIPTS[script] !== undefined) return [{ label: script, modules: [script] }];
    const modules = ownImports(script);
    // A script that imports only `node:` builtins has no module of ours to initialise.
    return modules.length === 0 ? [] : [{ label: `${script} (its own imports, in its order)`, modules }];
  }),
];

/**
 * Anything this gate would EVALUATE that is a script and is not listed as guarded. Computed
 * before a single process starts, and such a subject is not started at all.
 */
const wouldRun = (subject: FirstImport): string[] =>
  subject.modules.filter((module) => GUARDED_SCRIPTS[module] === undefined && existsSync(join(ROOT, module)) && readsProcessArguments(module));

const safe = subjects.filter((subject) => wouldRun(subject).length === 0);

describe("§V1028 (B246) — every plain-node entry point imports cleanly as the first module", () => {
  const runs = new Map<string, FirstImportRun>();

  beforeAll(async () => {
    for (const run of await importEachFirst(safe, CONCURRENCY)) runs.set(run.subject.label, run);
  }, 300_000);

  it("derives its scripts from the texts that name them, and from every project there is", () => {
    // If the loader moves or the invocation changes shape, the derivation returns nothing
    // and every case below would pass for want of subjects. These two are the proof it is
    // alive: one from `package.json`, one from CLAUDE.md.
    expect(scripts).toContain("src/mcp/serve.ts");
    expect(scripts).toContain("src/examples/build-examples.ts");
    for (const script of projectScripts.filter((path) => existsSync(join(ROOT, path)))) {
      expect(subjects.map((subject) => subject.label).join("\n"), `${script} is a project script and has no subject`).toContain(script);
    }
  });

  it("never evaluates a script whole unless it is listed as guarded", () => {
    expect(
      subjects.flatMap((subject) => wouldRun(subject).map((module) => `${subject.label} → ${module}`)),
      "These modules read `process.argv`, so importing them RUNS them — the examples build has no " +
        "main guard and rewrites every shipped example. The subjects named here were not started. " +
        "If the module has a main guard, add it to GUARDED_SCRIPTS with where the guard is; if it is " +
        "a library module that happens to read argv, move that read into the script that owns it.",
    ).toEqual([]);
  });

  it("keeps GUARDED_SCRIPTS honest: each is still a named script and still carries its guard", () => {
    for (const [script, where] of Object.entries(GUARDED_SCRIPTS)) {
      expect(where.length, `${script} has no account of its guard`).toBeGreaterThan(20);
      expect(scripts, `${script} is listed as a guarded script but no text names it any more — delete the entry`).toContain(script);
      expect(
        readFileSync(join(ROOT, script), "utf8"),
        `${script} no longer tests process.argv[1] — without a main guard, importing it runs it`,
      ).toMatch(/if\s*\([^)]*process\.argv\[1\]/);
    }
  });

  it.each(safe.map((subject) => [subject.label] as const))("%s", (label) => {
    const run = runs.get(label);
    if (run === undefined) throw new Error(`${label} was never started`);
    const failure = firstImportFailure(run);
    if (failure !== null) throw new Error(failure);
  });
});
