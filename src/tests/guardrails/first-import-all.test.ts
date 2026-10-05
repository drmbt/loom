import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ROOT,
  firstImportFailure,
  importEachFirst,
  readsProcessArguments,
  withoutComments,
  type FirstImportRun,
} from "./first-import.ts";

/**
 * §V1028 / B246, THE GENERAL FORM — every module under `src/domain`, `src/compiler` and
 * `src/runtime` imports cleanly as the FIRST module of a fresh `node`.
 *
 * `first-import.test.ts` holds the entry points that exist. This holds the class: B246 was a
 * constant read at module scope across an import cycle, and for such a read there is always
 * a module that breaks when it is loaded first — the one that DECLARES the constant, because
 * everything it reaches is evaluated before its own body is. Nobody had to import
 * `presets/morph-index.ts` first for the bug to be there; it was enough that somebody
 * eventually would, and a render script did. So every module in the three headless layers
 * gets its turn as the first one, and a cycle with a module-scope read across it cannot land
 * in them unseen, whichever entry point would have met it later.
 *
 * ## Why this is NOT on `test:gates` (and where it runs)
 *
 * It is one fresh process per module: 249 of them when it landed, three alive at once.
 * Measured on 14 cores: 6.3 s of wall at a load average of 13, 16–20 s at a load average of
 * 30, about 23 s of summed process time. That is the whole commit gate again, under the
 * same load. So it has its own script,
 * `pnpm test:first-import`, which a session runs after touching imports in these layers
 * (through `tools/heavy.sh`: it is a heavy command), and it runs in the full suite.
 * `gate-list.test.ts` records that by name, with the script, and checks the script exists.
 */

const LAYERS: readonly string[] = ["src/domain", "src/compiler", "src/runtime"];

/** How many fresh processes are alive at once. See `importEachFirst`. */
const CONCURRENCY = 3;

/**
 * Modules in these layers that plain node cannot import, each with the reason and the
 * TELL-TALE in its source that the reason rests on. Checked both ways: when the tell-tale is
 * gone the entry is stale and this gate says so.
 */
const NOT_A_PLAIN_NODE_MODULE: Readonly<Record<string, { readonly reason: string; readonly tell: RegExp }>> = {
  "src/runtime/models/inference.worker.ts": {
    reason: "a browser worker entry: it takes onnxruntime-web's wasm through Vite's `?url`, a specifier only the bundler resolves",
    tell: /\?url["']/,
  },
  "src/runtime/models/mediapipe-segmenter.ts": {
    reason: "browser only: it takes MediaPipe's wasm loader through Vite's `?url`, a specifier only the bundler resolves",
    tell: /\?url["']/,
  },
  "src/runtime/models/extract-model-signatures.ts": {
    reason: "a script, not a module: it reads `process.argv` at module scope and throws without a directory to read",
    tell: /\bprocess\s*\.\s*argv\b/,
  },
};

function modulesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...modulesUnder(path));
    // `.tsx` is left out by extension: node strips types, it does not compile JSX. Tests are
    // left out because a test file is not a module anything imports.
    else if (/\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)) found.push(relative(ROOT, path).split("\\").join("/"));
  }
  return found;
}

const modules = LAYERS.flatMap((layer) => modulesUnder(join(ROOT, layer))).sort();
const candidates = modules.filter((module) => NOT_A_PLAIN_NODE_MODULE[module] === undefined);

/**
 * A module that reads `process.argv` is a script, and importing a script runs it. One that is
 * not listed above is REFUSED BY NAME and never started — see `readsProcessArguments`.
 */
const unlistedScripts = candidates.filter(readsProcessArguments);
const subjects = candidates.filter((module) => !unlistedScripts.includes(module));

describe("§V1028 (B246) — every headless module imports cleanly as the first module", () => {
  const runs = new Map<string, FirstImportRun>();

  beforeAll(async () => {
    const started = await importEachFirst(
      subjects.map((module) => ({ label: module, modules: [module] })),
      CONCURRENCY,
    );
    for (const run of started) runs.set(run.subject.label, run);
  }, 600_000);

  it("finds the layers it claims to cover", () => {
    // A renamed layer would leave this gate green over nothing.
    for (const layer of LAYERS) {
      expect(subjects.filter((module) => module.startsWith(`${layer}/`)).length, `${layer} has no modules`).toBeGreaterThan(10);
    }
  });

  it("never imports a script: a module that reads process.argv is listed, by name", () => {
    expect(
      unlistedScripts,
      "These modules read `process.argv`, so importing them RUNS them, and they were not started. " +
        "A script belongs with the thing it serves, outside the library layers; if it must live " +
        "here, add it to NOT_A_PLAIN_NODE_MODULE with the reason.",
    ).toEqual([]);
  });

  it("keeps every exemption honest: the file exists and still carries its tell-tale", () => {
    for (const [module, { reason, tell }] of Object.entries(NOT_A_PLAIN_NODE_MODULE)) {
      expect(reason.length, `${module}'s exemption has no reason`).toBeGreaterThan(20);
      expect(modules, `${module} is exempted but is not a module under ${LAYERS.join(", ")} — delete the exemption`).toContain(module);
      if (!existsSync(join(ROOT, module))) continue;
      expect(
        tell.test(withoutComments(readFileSync(join(ROOT, module), "utf8"))),
        `${module} is exempted because of ${String(tell)}, which its source no longer contains — delete the exemption`,
      ).toBe(true);
    }
  });

  it.each(subjects.map((module) => [module] as const))("%s", (module) => {
    const run = runs.get(module);
    if (run === undefined) throw new Error(`${module} was never started`);
    const failure = firstImportFailure(run);
    if (failure !== null) throw new Error(failure);
  });
});
