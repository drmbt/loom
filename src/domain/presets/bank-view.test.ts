import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import type { GraphNode } from "../types/graph.ts";
import { isPageBank } from "./bank-view.ts";

/**
 * T1505b — THE `bankOf` GATE (`docs/presets-followups-design-2026-10-03.md` §1.4).
 *
 * A look's instance is a bank from outside, and a site that still asks
 * `node.type === PRESETS_NODE_TYPE` silently ignores it: a cue that cannot name `city`, a
 * listing that leaves it out, a Panel that drops it. Before this row thirteen product files
 * asked that question, so the one honest guard is against the CAUSE — the bare type test
 * itself — anywhere in `src/` outside the one module that owns it (`bank-view.ts`'s
 * `isPresetsNode` / `bankOf`). A site that really means "a Presets node and not a look"
 * (a bank's own Targets, say) says so through `isPresetsNode`, where a reader sees it.
 *
 * It walks the source tree rather than importing what it checks, so no selector can find
 * it: it is in `pnpm test:gates` (§V957, `gate-list.test.ts`).
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC = join(ROOT, "src");
const OWNER = "src/domain/presets/bank-view.ts";

/** A comparison of a node type with the bank's type, by constant or by literal, either way round. */
const BARE_TYPE_TEST = /(?:[!=]==\s*(?:PRESETS_NODE_TYPE\b|"presets"|'presets'))|(?:(?:\bPRESETS_NODE_TYPE|"presets"|'presets')\s*[!=]==)/;

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

describe("§T1505b — no bare Presets type test outside bank-view.ts", () => {
  it("the pattern catches every spelling of the test it exists to forbid, and not a bank's own data", () => {
    // Red-verified by construction: each of these is a line the gate must fail on.
    for (const line of [
      "if (node.type === PRESETS_NODE_TYPE) {",
      "node.type !== PRESETS_NODE_TYPE",
      "PRESETS_NODE_TYPE === node.type",
      'each.type === "presets"',
      "type !== 'presets'",
    ]) {
      expect(BARE_TYPE_TEST.test(line), line).toBe(true);
    }
    // …and the legitimate uses it must not swallow: naming the type, keying a table by it.
    for (const line of [
      "type: PRESETS_NODE_TYPE,",
      "[PRESETS_NODE_TYPE]: { w: 4, h: 1 },",
      'node("looks", "presets", [0, 0], {',
      'parsePresetBank(node.parameters["presets"])',
      "isPresetsNode(node)",
    ]) {
      expect(BARE_TYPE_TEST.test(line), line).toBe(false);
    }
  });

  it("finds none in src/ — every site asks isPresetsNode or bankOf", () => {
    const files = sources(SRC);
    // Reading real files, or it measures nothing.
    expect(files.length).toBeGreaterThan(500);
    expect(files.map((file) => relative(ROOT, file))).toContain(OWNER);
    const offending: string[] = [];
    for (const file of files) {
      const path = relative(ROOT, file);
      if (path === OWNER) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (BARE_TYPE_TEST.test(line)) offending.push(`${path}:${String(index + 1)}: ${line.trim()}`);
        });
    }
    expect(offending, "ask isPresetsNode or bankOf (src/domain/presets/bank-view.ts) instead").toEqual([]);
  });
});

describe("a page bank (§1.2 Q1)", () => {
  const bank = (targets: unknown): GraphNode => ({
    id: "b",
    type: "presets",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: { targets } as GraphNode["parameters"],
  });

  it("is a bank whose EVERY target is parent or parent.<key>", () => {
    expect(isPageBank(bank("parent"))).toBe(true);
    expect(isPageBank(bank("parent.tint, parent.speed"))).toBe(true);
    // An authoring tool for the internals is not one — the legitimate case beside it.
    expect(isPageBank(bank("blur1"))).toBe(false);
    expect(isPageBank(bank("parent blur1"))).toBe(false);
    expect(isPageBank(bank(""))).toBe(false);
    expect(isPageBank({ ...bank("parent"), type: "level" })).toBe(false);
  });
});
