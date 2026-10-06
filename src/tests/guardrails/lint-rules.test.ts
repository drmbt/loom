/**
 * Proves the three eslint-enforced invariants (T7/§V3, T8/§V11, T64/§V44) actually
 * fire — a lint rule nobody tests is a lint rule that can silently stop working.
 *
 * Each case lints a small in-memory snippet with the ESLint Node API against the
 * real `eslint.config.js`, using `lintText`'s `filePath` option to simulate where
 * the file "lives" without needing it to exist on disk.
 */
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const eslintConfigPath = fileURLToPath(new URL("../../../eslint.config.js", import.meta.url));

/** Lints `code` as if it lived at `relativePath` (relative to the repo root). */
async function lint(code: string, relativePath: string) {
  const eslint = new ESLint({ overrideConfigFile: eslintConfigPath, cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${relativePath}` });
  if (!result) throw new Error("expected exactly one lint result");
  return result;
}

function ruleIdsOf(messages: { ruleId: string | null }[]): (string | null)[] {
  return messages.map((message) => message.ruleId);
}

it("keeps peer checkouts and generated environments outside root source lint", async () => {
  const eslint = new ESLint({ overrideConfigFile: eslintConfigPath, cwd: repoRoot });
  expect(await eslint.isPathIgnored(`${repoRoot}.claude/worktrees/peer/src/app.ts`)).toBe(true);
  expect(await eslint.isPathIgnored(`${repoRoot}renders/on-nothing/.venv/vendor/worker.js`)).toBe(true);
  expect(await eslint.isPathIgnored(`${repoRoot}src/app/app.tsx`)).toBe(false);
});

describe("§V3 — vgpu import restricted to src/runtime/backend/vgpu/**", () => {
  const importsVgpu = 'import { init } from "vgpu";\nexport function use() { return init; }\n';
  const importsVgpuMock = 'import { frame } from "vgpu/mock";\nexport function use() { return frame; }\n';

  it("errors when vgpu is imported from a node definition", async () => {
    const result = await lint(importsVgpu, "src/nodes/definitions/solid.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("errors when vgpu is imported from elsewhere in src/ (e.g. the compiler)", async () => {
    const result = await lint(importsVgpu, "src/compiler/plan.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("errors on a vgpu subpath import (vgpu/mock), not just the bare specifier", async () => {
    const result = await lint(importsVgpuMock, "src/compiler/plan.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("does NOT error when vgpu is imported from the backend adapter itself", async () => {
    const result = await lint(importsVgpu, "src/runtime/backend/vgpu/adapter.ts");
    expect(ruleIdsOf(result.messages)).not.toContain("no-restricted-imports");
    expect(result.errorCount).toBe(0);
  });
});

describe("§V11 — src/nodes/definitions/** must run headless", () => {
  const importsReact = 'import { useState } from "react";\nexport function use() { return useState; }\n';
  const importsXyflow = 'import { Handle } from "@xyflow/react";\nexport function use() { return Handle; }\n';
  const importsUiAlias = 'import { theme } from "@ui/tokens.ts";\nexport function use() { return theme; }\n';

  it("errors when react is imported from a node definition", async () => {
    const result = await lint(importsReact, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("errors when @xyflow/react is imported from a node definition", async () => {
    const result = await lint(importsXyflow, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("errors when src/ui is imported (via alias) from a node definition", async () => {
    const result = await lint(importsUiAlias, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });

  it("does NOT error when react is imported outside src/nodes/definitions/**", async () => {
    const result = await lint(importsReact, "src/editor/graph-canvas/canvas.tsx");
    expect(ruleIdsOf(result.messages)).not.toContain("no-restricted-imports");
    expect(result.errorCount).toBe(0);
  });

  it("still enforces §V3 for node definitions (combined rule doesn't drop it)", async () => {
    const importsVgpu = 'import { init } from "vgpu";\nexport function use() { return init; }\n';
    const result = await lint(importsVgpu, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-imports");
  });
});

describe("§V44 — no wall-clock reads in src/nodes/**", () => {
  const usesPerformanceNow = "export function tick() { return performance.now(); }\n";
  const usesDateNow = "export function tick() { return Date.now(); }\n";
  const usesNewDate = "export function tick() { return new Date().getTime(); }\n";
  const usesRaf = "export function tick(cb: FrameRequestCallback) { return requestAnimationFrame(cb); }\n";

  it("errors on performance.now() inside a node definition", async () => {
    const result = await lint(usesPerformanceNow, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("errors on Date.now() inside a node definition", async () => {
    const result = await lint(usesDateNow, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("errors on new Date() inside src/nodes/** (not just definitions/)", async () => {
    const result = await lint(usesNewDate, "src/nodes/registry/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("errors on requestAnimationFrame() inside a node definition", async () => {
    const result = await lint(usesRaf, "src/nodes/definitions/foo.ts");
    expect(ruleIdsOf(result.messages)).toContain("no-restricted-syntax");
  });

  it("does NOT error on performance.now() outside src/nodes/** (e.g. the live clock transport)", async () => {
    const result = await lint(usesPerformanceNow, "src/domain/transport/live-clock.ts");
    expect(ruleIdsOf(result.messages)).not.toContain("no-restricted-syntax");
    expect(result.errorCount).toBe(0);
  });
});

/**
 * Bypass probes. A review confirmed the original selectors could be walked around;
 * these assert the holes are closed. Each case previously passed lint.
 */
describe("guardrail bypasses are closed", () => {
  it("§V3 — dynamic import of vgpu is caught", async () => {
    const { messages } = await lint(`const m = await import("vgpu");\nvoid m;\n`, "src/compiler/sneaky.ts");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("§V3 — an unlisted vgpu subpath is caught", async () => {
    const { messages } = await lint(`import x from "vgpu/webgpu";\nvoid x;\n`, "src/compiler/sneaky.ts");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("§V3 — the adapter itself still imports vgpu freely", async () => {
    const { messages } = await lint(
      `import { effect } from "vgpu";\nvoid effect;\n`,
      "src/runtime/backend/vgpu/ok.ts",
    );
    expect(messages).toEqual([]);
  });

  it("§V44 — performance.now() via a global object is caught", async () => {
    const { messages: viaWindow } = await lint(`export const t = window.performance.now();\n`, "src/nodes/definitions/a.ts");
    const { messages: viaGlobal } = await lint(`export const t = globalThis.performance.now();\n`, "src/nodes/definitions/b.ts");
    expect(viaWindow.length).toBeGreaterThan(0);
    expect(viaGlobal.length).toBeGreaterThan(0);
  });

  it("§V44 — aliasing performance is caught at the alias", async () => {
    const { messages } = await lint(`const p = performance;\nexport const t = p.now();\n`, "src/nodes/definitions/c.ts");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("§V44 — self.requestAnimationFrame and bare timers are caught", async () => {
    const { messages: raf } = await lint(`self.requestAnimationFrame(() => {});\n`, "src/nodes/definitions/d.ts");
    const { messages: timer } = await lint(`setInterval(() => {}, 16);\n`, "src/nodes/definitions/e.ts");
    expect(raf.length).toBeGreaterThan(0);
    expect(timer.length).toBeGreaterThan(0);
  });
});

describe("§V63 (T92) — compiler and runtime stay worker-ready", () => {
  it("errors on window/document in src/compiler/** and src/runtime/**", async () => {
    const { messages: win } = await lint(
      `export const w = window.innerWidth;\n`,
      "src/compiler/layout.ts",
    );
    const { messages: doc } = await lint(
      `export const el = document.createElement("canvas");\n`,
      "src/runtime/previews/tiles.ts",
    );
    expect(ruleIdsOf(win)).toContain("no-restricted-globals");
    expect(ruleIdsOf(doc)).toContain("no-restricted-globals");
  });

  it("does NOT restrict DOM globals in the editor, which owns the DOM", async () => {
    const { messages } = await lint(
      `export const w = window.innerWidth;\n`,
      "src/editor/graph-canvas/viewport.ts",
    );
    expect(ruleIdsOf(messages)).not.toContain("no-restricted-globals");
  });
});

describe("§V29 (T93) — store internals unreachable outside the command bus", () => {
  const pokesInternals = `import { createGraphStore } from "../domain/graph/store.ts";
const store = createGraphStore();
export const backdoor = store.internals;
`;
  const pokesRaw = `import { createGraphStore } from "../domain/graph/store.ts";
const store = createGraphStore();
export const backdoor = store.raw;
`;

  it("errors on .internals access from app/editor code", async () => {
    const { messages: fromApp } = await lint(pokesInternals, "src/app/wiring.ts");
    const { messages: fromEditor } = await lint(pokesInternals, "src/editor/inspector/hack.ts");
    expect(ruleIdsOf(fromApp)).toContain("no-restricted-syntax");
    expect(ruleIdsOf(fromEditor)).toContain("no-restricted-syntax");
  });

  it("errors on the store's .raw escape hatch outside the bus", async () => {
    const { messages } = await lint(pokesRaw, "src/app/wiring.ts");
    expect(ruleIdsOf(messages)).toContain("no-restricted-syntax");
  });

  it("still catches vgpu dynamic imports in the same files (rule values replace, not merge)", async () => {
    const { messages } = await lint(
      `export const lazy = () => import("vgpu");\n`,
      "src/editor/inspector/hack.ts",
    );
    expect(ruleIdsOf(messages)).toContain("no-restricted-syntax");
  });

  it("does NOT fire inside src/domain/commands, which owns the mutation path", async () => {
    const { messages } = await lint(pokesInternals, "src/domain/commands/wire.ts");
    expect(ruleIdsOf(messages)).not.toContain("no-restricted-syntax");
  });
});

/**
 * §V1028 / B246 — the layering zones.
 *
 * B246 was ONE line: `src/domain/parameters/node-references.ts` imported a value from the
 * presets layer, which imports the parameter read path. That closed a cycle, a constant was
 * read across it at module scope, and every plain-node entry point died at import. The zone
 * is the guard against the cause (the edge), so what is asserted here is the edge in every
 * spelling that reaches the module — and, as carefully, each legitimate import the rule sits
 * next to and must not swallow: the SAME two directories in the direction that is correct.
 */
describe("§V1028 (B246) — a layer may not import the layer that imports it", () => {
  const ZONE = "v1028/layering-zone";
  const zoneMessages = (messages: { ruleId: string | null; message: string }[]) =>
    messages.filter((message) => message.ruleId === ZONE).map((message) => message.message);

  it("refuses B246's own line: parameters importing a VALUE from presets", async () => {
    const { messages } = await lint(
      'import { NO_MORPHS } from "../presets/morph-index.ts";\nexport const NO_FLATTENING = { morphs: NO_MORPHS };\n',
      "src/domain/parameters/node-references.ts",
    );
    const [message, ...rest] = zoneMessages(messages);
    expect(rest).toEqual([]);
    // The message has to carry the reason AND the way out, or the next author aliases around it.
    expect(message).toContain("§V1028");
    expect(message).toContain("B246");
    expect(message).toContain("declare what this layer needs HERE");
  });

  it("resolves the specifier, so every spelling of the same target is refused", async () => {
    for (const specifier of ["../presets/morph-index.ts", "@domain/presets/morph-index.ts", "@/domain/presets/morph-index.ts"]) {
      const { messages } = await lint(
        `import { NO_MORPHS } from "${specifier}";\nexport const held = NO_MORPHS;\n`,
        "src/domain/parameters/node-references.ts",
      );
      expect(zoneMessages(messages), specifier).toHaveLength(1);
    }
  });

  it("refuses every form that reaches the module, not only a static import", async () => {
    const forms = [
      'export { NO_MORPHS } from "../presets/morph-index.ts";\n',
      'export * from "../presets/morph-index.ts";\n',
      'export const lazy = () => import("../presets/morph-index.ts");\n',
      'export type Origins = import("../presets/morph-index.ts").PublishedOrigins;\n',
    ];
    for (const code of forms) {
      const { messages } = await lint(code, "src/domain/parameters/node-references.ts");
      expect(zoneMessages(messages), code).toHaveLength(1);
    }
  });

  it("refuses a type-only import in both spellings (the inline one still loads the module)", async () => {
    const erased = 'import type { PublishedOrigins } from "../presets/morph-index.ts";\nexport type Held = PublishedOrigins;\n';
    const kept = 'import { type PublishedOrigins } from "../presets/morph-index.ts";\nexport type Held = PublishedOrigins;\n';
    expect(zoneMessages((await lint(erased, "src/domain/parameters/resolve.ts")).messages)).toHaveLength(1);
    expect(zoneMessages((await lint(kept, "src/domain/parameters/resolve.ts")).messages)).toHaveLength(1);
  });

  it("covers test-support.ts, which is a module and not a test (B246's fix had to change it)", async () => {
    const { messages } = await lint(
      'import { NO_MORPHS } from "../presets/morph-index.ts";\nexport const held = NO_MORPHS;\n',
      "src/domain/parameters/test-support.ts",
    );
    expect(zoneMessages(messages)).toHaveLength(1);
  });

  it("does NOT refuse the same edge in the direction that is correct: presets importing parameters", async () => {
    const result = await lint(
      'import { NO_MORPHS, resolveParameter } from "../parameters/resolve.ts";\nexport { NO_MORPHS };\nexport const read = resolveParameter;\n',
      "src/domain/presets/morph-index.ts",
    );
    expect(result.messages).toEqual([]);
  });

  it("does NOT refuse the parameters layer its own files, the types, or a name that merely contains the word", async () => {
    const result = await lint(
      [
        'import { NO_MORPHS } from "./resolve.ts";',
        'import type { ParameterValue } from "../types/parameters.ts";',
        'import { presetsOf } from "./presets.ts";',
        'import { migratePresets } from "../project/presets-migration.ts";',
        "export const held: [typeof NO_MORPHS, ParameterValue | undefined, unknown, unknown] = [NO_MORPHS, undefined, presetsOf, migratePresets];",
        "",
      ].join("\n"),
      "src/domain/parameters/node-references.ts",
    );
    expect(result.messages).toEqual([]);
  });

  it("does NOT refuse a test: a test file is its own first module and may compose the real layers", async () => {
    const result = await lint(
      'import { NO_MORPHS } from "../presets/morph-index.ts";\nexport const held = NO_MORPHS;\n',
      "src/domain/parameters/resolve.test.ts",
    );
    expect(result.messages).toEqual([]);
  });

  it("holds §V81's direction too: parameters may not import components, components may import parameters", async () => {
    const back = await lint(
      'import { parentBindResolver } from "../components/parent-scope.ts";\nexport const held = parentBindResolver;\n',
      "src/domain/parameters/resolve.ts",
    );
    const forward = await lint(
      'import { resolveParameter } from "../parameters/resolve.ts";\nexport const held = resolveParameter;\n',
      "src/domain/components/parent-scope.ts",
    );
    expect(zoneMessages(back.messages)).toHaveLength(1);
    expect(zoneMessages(back.messages)[0]).toContain("ParentBindResolver");
    expect(forward.messages).toEqual([]);
  });

  it("keeps the domain headless: no editor, no ui, no React — by any spelling", async () => {
    const reaches = [
      'import { nodeBox } from "@editor/nodes/node-box.ts";\nexport const held = nodeBox;\n',
      'import { theme } from "../../ui/tokens.ts";\nexport const held = theme;\n',
      'import { useState } from "react";\nexport const held = useState;\n',
      'import { createRoot } from "react-dom/client";\nexport const held = createRoot;\n',
      'import type { Node } from "@xyflow/react";\nexport type Held = Node;\n',
    ];
    for (const code of reaches) {
      const { messages } = await lint(code, "src/domain/graph/layout.ts");
      expect(zoneMessages(messages), code).toHaveLength(1);
      expect(zoneMessages(messages)[0]).toContain("the domain is headless");
    }
  });

  it("does NOT refuse the domain a package it really uses, nor the editor its import of the domain", async () => {
    const store = await lint(
      'import { createStore } from "zustand/vanilla";\nexport const held = createStore;\n',
      "src/domain/graph/store.ts",
    );
    const editor = await lint(
      'import { useState } from "react";\nimport { layoutGraph } from "@domain/graph/layout.ts";\nexport const held = [useState, layoutGraph];\n',
      "src/editor/graph-canvas/arrange.ts",
    );
    expect(store.messages).toEqual([]);
    expect(editor.messages).toEqual([]);
  });

  it("holds the two single-module promises in the presets layer, and only on those modules", async () => {
    // cue-list.ts: commands.ts reads its constants at module scope, so it may not import back.
    const cueList = await lint(
      'import { planRecall } from "./commands.ts";\nimport { fireCue } from "./cue-commands.ts";\nexport const held = [planRecall, fireCue];\n',
      "src/domain/presets/cue-list.ts",
    );
    expect(zoneMessages(cueList.messages)).toHaveLength(2);
    // …while cue-commands.ts importing commands.ts is how the recall planner is reached.
    const cueCommands = await lint(
      'import { planRecall } from "./commands.ts";\nimport { MORPH_CURVES } from "./bank.ts";\nexport const held = [planRecall, MORPH_CURVES];\n',
      "src/domain/presets/cue-commands.ts",
    );
    expect(cueCommands.messages).toEqual([]);

    // morph.ts: data only, because graph/names.ts imports it.
    const morph = await lint(
      [
        'import { nodeNames } from "../graph/names.ts";',
        'import type { NodeRegistryView } from "../../nodes/registry/registry.ts";',
        'import { resolveParameter } from "../parameters/resolve.ts";',
        "export const held: [unknown, NodeRegistryView | undefined, unknown] = [nodeNames, undefined, resolveParameter];",
        "",
      ].join("\n"),
      "src/domain/presets/morph.ts",
    );
    expect(zoneMessages(morph.messages)).toHaveLength(3);
    // …while the index beside it is exactly where the graph, the registry and the resolver meet.
    const morphIndex = await lint(
      [
        'import { nodeNames } from "../graph/names.ts";',
        'import type { NodeRegistryView } from "../../nodes/registry/registry.ts";',
        'import { resolveParameter } from "../parameters/resolve.ts";',
        'import { MORPH_CURVES } from "./bank.ts";',
        "export const held: [unknown, NodeRegistryView | undefined, unknown, unknown] = [nodeNames, undefined, resolveParameter, MORPH_CURVES];",
        "",
      ].join("\n"),
      "src/domain/presets/morph-index.ts",
    );
    expect(morphIndex.messages).toEqual([]);
    const morphOwn = await lint(
      'import { MORPH_CURVES } from "./bank.ts";\nexport const held = MORPH_CURVES;\n',
      "src/domain/presets/morph.ts",
    );
    expect(morphOwn.messages).toEqual([]);
  });
});
