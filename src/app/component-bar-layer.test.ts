import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * VN1 — the component bar is drawn ABOVE the node preview tiles.
 *
 * The report: "Shift+C pops up a not obvious top bar that renders under node previews."
 * Every preview pixel in a graph pane comes from one canvas (`.previewSurface`), which is a
 * later sibling of the bar in the same stacking context. At an equal z-index the later
 * sibling wins, so the bar's naming prompt and breadcrumb were painted over by any tile
 * that reached the top of the pane.
 *
 * jsdom has no layout and no compositor, so the picture cannot be asserted here. What can
 * be is the CAUSE: the two layers, read from the stylesheets the app ships and resolved
 * through the tokens, with the bar strictly above the surface. Sensitivity: putting `.bar`
 * back on `--z-canvas-overlay` reddens this.
 */

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const tokens = read("../ui/tokens.css");

function tokenValue(name: string): number {
  const match = new RegExp(`${name}:\\s*(-?\\d+)\\s*;`).exec(tokens);
  if (match === null) throw new Error(`no numeric token ${name} in tokens.css`);
  return Number(match[1]);
}

/** The z-index a class resolves to: the token its rule names, looked up in tokens.css. */
function layerOf(css: string, className: string): number {
  const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`no .${className} rule`);
  const token = /z-index:\s*var\((--[\w-]+)\)/.exec(rule[1] as string);
  if (token === null) throw new Error(`.${className} names no z-index token`);
  return tokenValue(token[1] as string);
}

describe("the component bar's layer (VN1)", () => {
  it("sits above the shared preview surface, so a preview tile cannot cover the naming prompt", () => {
    const bar = layerOf(read("./component-bar.module.css"), "bar");
    const previews = layerOf(read("./panes.module.css"), "previewSurface");
    expect(bar).toBeGreaterThan(previews);
  });

  it("stays below popovers, so a menu opened over the canvas still covers the bar", () => {
    expect(layerOf(read("./component-bar.module.css"), "bar")).toBeLessThan(tokenValue("--z-popover"));
  });
});
