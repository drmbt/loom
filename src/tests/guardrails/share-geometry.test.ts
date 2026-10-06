import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * T1653b — A VALUE IS NEVER DRAWN AS A BOX THAT CHANGES SIZE, outside the one primitive.
 *
 * A slider's fill was a `<div>` whose width was the value. To Chromium a box that changes
 * is a changed paint chunk, and that forces the full compositor update — 11 ms on a
 * 200-node project for every value a slider was dragged through, and on up to half of its
 * idle frames from the value bars alone (`src/ui/primitives/share-fill.tsx` has the
 * measurements and the rule). The primitive is what draws a share; this gate is what keeps
 * the next control from growing a width.
 *
 * Derived, not listed: every component under `src/ui` and `src/editor` is read, and every
 * place it writes GEOMETRY FROM A VALUE in an inline style is found — a percentage built
 * from an expression on a size or an inset, a `scale(…)` or a `clip-path` built from one,
 * and the same written imperatively (`element.style.width = …`). Each must be the
 * primitive or be named below with the reason it is not a share and an exact count, so a
 * second write in an exempt file fails too.
 *
 * It cannot see what a browser does with the result. `src/tests/e2e/canvas-paint.spec.ts`
 * can: it counts the full compositor updates of a run of writes to each control.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");
const SCANNED = ["ui", "editor"];
const PRIMITIVE = "ui/primitives/share-fill.tsx";

const GEOMETRY = "width|inlineSize|height|blockSize|left|right|top|bottom|insetInlineStart|insetInlineEnd|insetBlockStart|insetBlockEnd|flexBasis|paddingInlineStart|paddingInlineEnd|paddingLeft|paddingRight";
/** `width: `${share * 100}%``: a size or an inset that is a percentage of an expression. */
const PERCENT_OF_A_VALUE = new RegExp(`\\b(${GEOMETRY})\\s*:\\s*\`[^\`]*\\$\\{[^\`]*%[^\`]*\``, "g");
/** `transform: `scaleX(${share})``, `clipPath: `inset(0 ${rest}% 0 0)``. */
const SCALE_OR_CLIP_OF_A_VALUE = /\b(transform|clipPath)\s*:\s*`[^`]*(?:scale[XY]?\(|inset\(|polygon\()[^`]*\$\{[^`]*`/g;
/** `element.style.width = …` for the same properties. */
const IMPERATIVE = new RegExp(`\\.style\\.(${GEOMETRY}|transform|clipPath)\\s*=[^=]`, "g");

interface Exemption {
  readonly file: string;
  readonly property: string;
  readonly writes: number;
  readonly why: string;
}

const NOT_A_SHARE: readonly Exemption[] = [
  {
    file: "editor/controls/control-widget.tsx",
    property: "left",
    writes: 3,
    why: "Two are MARKS, not values: the slider's default tick and the XY pad's home, which move when the stored default or the range is edited and not when the control is played. The third is the XY pad's puck: a point moving in two axes, not a share of a track. It does force a full compositor update per write (measured, T1653b) and is listed on that row as not done; do not add a fourth here for a new control.",
  },
  {
    file: "editor/controls/control-widget.tsx",
    property: "bottom",
    writes: 2,
    why: "The XY pad's home mark and its puck, as above.",
  },
  {
    file: "editor/nodes/value-bars.tsx",
    property: "insetInlineStart",
    writes: 1,
    why: "Where ZERO is on a bipolar track: a 1px mark that moves when the range the bar is drawn against moves, not when the value does.",
  },
  {
    file: "editor/viewer/viewer-axis-gizmo.tsx",
    property: "left",
    writes: 1,
    why: "The axis gizmo's three labels, placed by the view's orientation: points on a disc in the viewer, not a share, and not under the canvas.",
  },
  {
    file: "editor/viewer/viewer-axis-gizmo.tsx",
    property: "top",
    writes: 1,
    why: "As above.",
  },
  {
    file: "ui/controls/stops-field.tsx",
    property: "left",
    writes: 1,
    why: "A gradient stop's handle, at its position along the ramp: a handle the hand drags, one per stop, not a share of a track.",
  },
];

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/testing\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

/** Comments out: the prose that explains the rule quotes what it forbids. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function writesIn(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const pattern of [PERCENT_OF_A_VALUE, SCALE_OR_CLIP_OF_A_VALUE, IMPERATIVE]) {
    for (const match of text.matchAll(pattern)) found.set(match[1] as string, (found.get(match[1] as string) ?? 0) + 1);
  }
  return found;
}

describe("T1653b — a value is drawn as a share of a fixed box, in one place", () => {
  const files = SCANNED.flatMap((directory) => sources(join(SRC, directory)));

  it("no component drives geometry from a value in an inline style, except the primitive and the points named", () => {
    const problems: string[] = [];
    const seen = new Map<string, number>();
    for (const path of files) {
      const file = relative(SRC, path).split("\\").join("/");
      if (file === PRIMITIVE) continue;
      for (const [property, writes] of writesIn(code(readFileSync(path, "utf8")))) {
        seen.set(`${file}:${property}`, writes);
        const exempt = NOT_A_SHARE.find((entry) => entry.file === file && entry.property === property);
        if (exempt === undefined) {
          problems.push(`${file} writes \`${property}\` from a value ${String(writes)}x. A share of a track is <ShareFill> (${PRIMITIVE}); a box that changes size costs a full compositor update per change. If it is not a share, name it in NOT_A_SHARE with the reason.`);
        } else if (exempt.writes !== writes) {
          problems.push(`${file} writes \`${property}\` from a value ${String(writes)}x and ${String(exempt.writes)} are declared. A declaration covers the writes it names and no others.`);
        }
      }
    }
    for (const entry of NOT_A_SHARE) {
      if (!seen.has(`${entry.file}:${entry.property}`)) problems.push(`NOT_A_SHARE names ${entry.file}:${entry.property}, which no longer writes it: delete the line.`);
    }
    expect(problems).toEqual([]);
  });

  it("the primitive is the one place that writes a share, and it writes it as padding", () => {
    const primitive = writesIn(code(readFileSync(join(SRC, PRIMITIVE), "utf8")));
    expect([...primitive.keys()].sort()).toEqual([]);
    // Its paddings are built by a function, not a template the scan above would see: say so by reading it.
    const text = code(readFileSync(join(SRC, PRIMITIVE), "utf8"));
    expect(text).toMatch(/paddingInlineStart:\s*percent\(start\)/);
    expect(text).toMatch(/paddingInlineEnd:/);
    expect(text).not.toMatch(/\b(width|inlineSize|transform|clipPath)\s*:/);
  });

  it("scans a real tree, and sees the four that use the primitive", () => {
    expect(files.length).toBeGreaterThan(200);
    const users = files.filter((path) => /<ShareFill\b/.test(code(readFileSync(path, "utf8")))).map((path) => relative(SRC, path).split("\\").join("/")).sort();
    expect(users).toEqual(["editor/controls/board-members.tsx", "editor/controls/control-widget.tsx", "editor/nodes/value-bars.tsx", "ui/controls/number-field.tsx"]);
  });
});
