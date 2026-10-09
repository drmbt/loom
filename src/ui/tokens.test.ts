import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PORT_FAMILY_VAR, portFamilyColor } from "./ports.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const TOKENS = join(SRC, "ui", "tokens.css");
const tokensCss = readFileSync(TOKENS, "utf8");

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(path, out);
      continue;
    }
    // "Component file" = anything that renders or styles.
    if (!/\.(tsx|ts|css)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (path === TOKENS) continue;
    out.push(path);
  }
  return out;
}

describe("T708 — text remains readable against its surfaces", () => {
  it("keeps dim text legible against every surface it is set on", () => {
    const contrast = (a: string, b: string) => {
      const luminance = (hex: string) => {
        const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
        const [r, g, bl] = channels.map((c) =>
          c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
        );
        return 0.2126729 * r! + 0.7151522 * g! + 0.072175 * bl!;
      };
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const hex = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokensCss)![1]!;
    for (const surface of ["--bg-panel", "--bg-raise"]) {
      expect(contrast(hex("--text-dim"), hex(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("V26 — port family colors are semantic and complete", () => {
  it("gives every PortType.kind its own token", () => {
    const values = Object.values(PORT_FAMILY_VAR);
    expect(new Set(values).size).toBe(values.length);
    for (const token of values) {
      expect(tokensCss).toMatch(new RegExp(`${token}:\\s*[^;]+;`));
    }
  });

  it("resolves a kind to a var() reference, never to a literal", () => {
    expect(portFamilyColor("texture2d")).toBe("var(--port-texture2d)");
    expect(portFamilyColor("audioFeatures")).toBe("var(--port-audioFeatures)");
    for (const kind of Object.keys(PORT_FAMILY_VAR) as Array<keyof typeof PORT_FAMILY_VAR>) {
      expect(portFamilyColor(kind)).not.toContain("#");
    }
  });
});

describe("V19 — the motion and focus floor is declared in tokens", () => {
  it("zeroes the motion tokens under prefers-reduced-motion", () => {
    const reduced = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("--dur-fast: 0ms");
    expect(reduced).toContain("--motion-scale: 0");
  });

  it("declares a focus ring token used by the base layer", () => {
    expect(tokensCss).toContain("--focus-ring:");
    const base = readFileSync(join(SRC, "ui", "base.css"), "utf8");
    expect(base).toContain(":focus-visible");
    expect(base).toContain("var(--focus-ring)");
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

/**
 * B214 (§V957) — A `var()` NOBODY DEFINED IS A DECLARATION NOBODY APPLIES.
 *
 * `height: var(--space-10)` sat in `editor/nodes/value-plot.module.css` from the day that
 * file was written. `--space-10` is defined nowhere. CSS does not warn about that: the
 * property is computed as the guaranteed-invalid value, the declaration is dropped at
 * used-value time, and the element simply lays out as though the line had never been
 * typed. Every value node's curve has therefore been sized by its SVG's intrinsic ratio —
 * i.e. by the node's width — for a year, and nothing anywhere went red. A reference
 * to a token has the correct syntax even when its definition is missing.
 *
 * That is the silent-failure class this gate closes, and it is the same shape as an
 * undefined token RENAMED out from under a consumer — the rename lands green, the
 * consumer keeps the syntax, and the styling quietly stops.
 *
 * ## What counts as defined
 *
 * Everything the tree declares anywhere: `tokens.css`, a component module that sets its
 * own local custom property (`--node-width`), an `@property` rule, a React inline-style
 * object key, a `setProperty` call. Custom properties are NOT scoped by CSS Modules — they
 * are inherited through the DOM at runtime — so "defined somewhere in the tree" is the
 * only claim a static walk can honestly make. That makes this gate DELIBERATELY
 * conservative: it catches the token that exists NOWHERE, not the one defined on an
 * element that happens not to be an ancestor. A false positive here would get the gate
 * deleted; a missed cousin of the bug would not.
 *
 * ## What is not a violation
 *
 * `var(--x, 12px)` states its own answer when `--x` is absent, which is the documented way
 * to reference a property that may not be set (`--slot-aspect`, `--border-color`). Only a
 * reference with NO fallback is a claim that the token exists. Comments are blanked before
 * the scan — this very file discusses `var(--y)` in prose, and a detector that reads prose
 * gets an exemption written for it, which is how a derived list becomes a remembered one.
 *
 * ## Cost
 *
 * One read of every `.css`/`.ts`/`.tsx` under `src`, ~90 ms. `test:gates` runs before every
 * commit and that budget is part of its contract (see `guardrails/gate-list.test.ts`).
 */

/** The token names a source declares — CSS, `@property`, inline-style keys, `setProperty`. */
const DEFINES = /(?:^|[\s;{(,])["'`]?(--[\w-]+)["'`]?\s*:/gm;
const DEFINES_AT_PROPERTY = /@property\s+(--[\w-]+)/g;
const DEFINES_VIA_SCRIPT = /setProperty\(\s*["'`](--[\w-]+)["'`]/g;
/** A reference, plus the character that follows the name: `,` means it carries a fallback. */
const REFERENCES = /var\(\s*(--[\w-]+)\s*([,)])/g;

/**
 * Comments, blanked rather than removed, so a reported line number is the line a reader
 * will find the reference on.
 */
function blankComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match: string, lead: string) => lead + blank(match.slice(lead.length)));
}

function definitionsIn(source: string): string[] {
  const names: string[] = [];
  for (const pattern of [DEFINES, DEFINES_AT_PROPERTY, DEFINES_VIA_SCRIPT]) {
    for (const match of source.matchAll(pattern)) names.push(match[1]!);
  }
  return names;
}

/** Every `var(--x)` with no fallback, with the 1-based line it sits on. */
function bareReferencesIn(source: string): Array<{ token: string; line: number }> {
  const found: Array<{ token: string; line: number }> = [];
  for (const match of source.matchAll(REFERENCES)) {
    if (match[2] === ",") continue;
    const line = source.slice(0, match.index).split("\n").length;
    found.push({ token: match[1]!, line });
  }
  return found;
}

/**
 * KNOWN UNDEFINED — the rest of what the B214 sweep turned up, each one a real dropped
 * declaration and each one someone else's file to fix.
 *
 * This is a DEBT LIST, not a set of legitimate exceptions: every row is a bug awaiting its
 * own row on the board, listed here so this gate can go green on the tree as it stands
 * rather than being landed red (a gate that ships red gets skipped, and a skipped gate is
 * no gate). The list is checked in BOTH directions below, so fixing one of these forces
 * the row out and the list cannot rot into a permanent exemption.
 */
const KNOWN_UNDEFINED: Readonly<Record<string, string>> = {
  // B215 emptied this list: all six references now point at tokens the tree defines.
  // A row here is a shipped defect parked with its reason, never a place to leave one.
};

describe("B214 — every var() reference resolves to a token the tree defines", () => {
  const files = [TOKENS, ...collect(SRC)];
  const sources = new Map(files.map((file) => [file, blankComments(readFileSync(file, "utf8"))]));
  const defined = new Set(
    [...sources.values()].flatMap((source) => definitionsIn(source)),
  );
  const undefinedUses = [...sources]
    .flatMap(([file, source]) =>
      bareReferencesIn(source).map((reference) => ({
        ...reference,
        file: `src/${relative(SRC, file)}`,
      })),
    )
    .filter(({ token }) => !defined.has(token));

  it("scans the whole styled tree and finds the token scale in it", () => {
    // Guards the guard: a walker that read nothing, or a definition regex that matched
    // nothing, would pass every assertion below by finding no references at all.
    expect(files.length).toBeGreaterThan(200);
    expect(defined.size).toBeGreaterThan(100);
    for (const token of ["--space-48", "--bg-panel", "--node-width"]) {
      expect(defined.has(token), `${token} should have been collected as defined`).toBe(true);
    }
  });

  it("reports a reference whose token exists nowhere, naming file, line and token", () => {
    // The detector, shown failing on the literal bug this row was opened for. Held as a
    // fixture rather than as the tree, so this stays red-verified after the tree is fixed.
    const broken = ".canvas {\n  width: 100%;\n  height: var(--space-10);\n}\n";
    expect(bareReferencesIn(blankComments(broken))).toEqual([{ token: "--space-10", line: 3 }]);
    expect(defined.has("--space-10")).toBe(false);
  });

  it("does not report a reference that carries its own fallback", () => {
    // The legitimate case this guard could swallow, taken from the real tree:
    // `--border-color` is referenced once, in node-view.module.css, and defined nowhere —
    // and that is CORRECT, because the reference states what to do without it.
    expect(defined.has("--border-color")).toBe(false);
    const nodeView = sources.get(join(SRC, "editor", "nodes", "node-view.module.css"))!;
    expect(nodeView).toContain("var(--border-color,");
    expect(bareReferencesIn(nodeView).map(({ token }) => token)).not.toContain("--border-color");
  });

  it("does not report a token a module defines for itself", () => {
    // `--node-width` lives in node-view.module.css, never in tokens.css. A gate that only
    // read the token file would flag it, be wrong, and be deleted within the week.
    expect(undefinedUses.map(({ token }) => token)).not.toContain("--node-width");
    // Same for a var read through JS rather than declared in CSS.
    expect(undefinedUses.map(({ token }) => token)).not.toContain("--status-color");
  });

  it("finds no undefined token outside the known-debt list", () => {
    const unexpected = undefinedUses
      .filter(({ file, token }) => KNOWN_UNDEFINED[`${file}:${token}`] === undefined)
      .map(({ file, line, token }) => `${file}:${line} references ${token}, which is defined nowhere`);
    expect(
      unexpected,
      "A var() with no fallback and no definition anywhere in the tree: CSS drops the whole " +
        "declaration silently, so the element lays out as though the line were absent (B214). " +
        "Point it at a token that exists, add the token to ui/tokens.css, or give the " +
        "reference a fallback if it is genuinely optional.",
    ).toEqual([]);
  });

  it("keeps the debt list honest: a row that has been fixed must be deleted", () => {
    const live = new Set(undefinedUses.map(({ file, token }) => `${file}:${token}`));
    for (const [key, reason] of Object.entries(KNOWN_UNDEFINED)) {
      expect(reason.length, `${key} is listed with no reason`).toBeGreaterThan(20);
      expect(
        live,
        `${key} is listed as known-undefined but now resolves — delete the row`,
      ).toContain(key);
    }
  });
});
