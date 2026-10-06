import { describe, expect, it } from "vitest";

import { CONTROL_DEFAULT_KEYS, controlDefaultState } from "../nodes/definitions/controls.ts";
import { listExamples, listProjectDocuments, listStarterComponentFiles, type ExampleFile } from "./catalogue.ts";

/**
 * EVERY SHIPPED CONTROL STORES ITS DEFAULT (T1619b, the lead's ruling for the owner, 2026-10-06).
 *
 * ## What this is the gate for
 *
 * A Slider, a Toggle and an XY Pad reset to the default they STORE, and one that stores none
 * has none: `control.reset` refuses it by name and the desk draws no mark on it
 * (`controlDefaults`). That rule exists because the alternative shipped once: a control whose
 * source authored no default reset to the type's 0.5, a number nobody chose, silently.
 *
 * A document SOURCE is written at the current definition version, so the version 1 → 2
 * `migrate` never runs on what it builds, and a source that forgets the default ships a
 * control the owner cannot reset. This file is what catches that: a shipped example, starter
 * component or project document holding a control with no stored default fails here, by name.
 *
 * ## Why it is a document-set walker, and why it is on `pnpm test:gates`
 *
 * It reads the shipped BYTES of every `.loom.json`, so it has no import edge from any
 * document source and no dependency-graph selector can find it (§V957). `gate-list.test.ts`
 * holds it on the gate script.
 *
 * ## THE LEDGER IS HONEST IN BOTH DIRECTIONS (`NOT_YET_RENAMED`'s manner)
 *
 * `NO_DEFAULT_YET` lists the files written before the rule with the EXACT number of
 * controls each still owes. Not an allow-list of files: a count. A file not listed must be
 * clean. A listed file's count must be exactly what is written: lower it when controls gain
 * defaults, remove the line at zero; it may never go up. An entry for a file that is gone
 * fails too.
 *
 * The files on it are version-1 documents: opened in the app each control migrates and
 * takes the value in the file as its default, so nothing is wrong for whoever opens one.
 * What is owed is the SOURCE: the next build of it writes version-2 controls, and those
 * must carry their defaults.
 */

/** repo-relative path → the number of controls in it that store no default yet. */
export const NO_DEFAULT_YET: Readonly<Record<string, number>> = {
  // T1400b: four sliders each, written before controls held a default.
  "projects/on-nothing/sleep-like-a-baby-2.loom.json": 4,
  "projects/on-nothing/sleep-like-a-baby.loom.json": 4,
};

interface ShippedFile {
  /** Repo-relative, forward slashes: the ledger's key and the name in every message. */
  readonly path: string;
  readonly text: string;
}

const under = (prefix: string, files: readonly ExampleFile[]): ShippedFile[] =>
  files.map((file) => ({ path: `${prefix}${file.fileName}`, text: file.text }));

const SHIPPED: readonly ShippedFile[] = [
  ...under("examples/", listExamples()),
  ...under("examples/components/", listStarterComponentFiles()),
  ...under("projects/", listProjectDocuments()),
];

interface StoredGraph {
  readonly nodes?: Readonly<Record<string, { readonly type?: unknown; readonly label?: unknown; readonly parameters?: unknown }>>;
}

interface StoredFile {
  readonly graph?: StoredGraph;
  readonly componentLibrary?: { readonly components?: ReadonlyArray<{ readonly componentId?: unknown; readonly graph?: StoredGraph }> };
}

/** Every control of a shipped file that stores no default, as `name (type, graph): keys`, in a stable order. */
function controlsWithoutDefault(fileText: string): string[] {
  const file = JSON.parse(fileText) as StoredFile;
  const graphs: Array<readonly [string, StoredGraph]> = [];
  if (file.graph !== undefined) graphs.push(["root", file.graph]);
  for (const component of file.componentLibrary?.components ?? []) {
    if (component.graph !== undefined) graphs.push([`component ${String(component.componentId)}`, component.graph]);
  }
  const found: string[] = [];
  for (const [where, graph] of graphs) {
    for (const id of Object.keys(graph.nodes ?? {}).sort()) {
      const node = graph.nodes?.[id];
      if (typeof node?.type !== "string" || CONTROL_DEFAULT_KEYS[node.type] === undefined) continue;
      const parameters = typeof node.parameters === "object" && node.parameters !== null ? (node.parameters as Record<string, never>) : {};
      const missing = controlDefaultState({ type: node.type, parameters })?.missing ?? [];
      if (missing.length === 0) continue;
      const defaults = missing.map((key) => CONTROL_DEFAULT_KEYS[node.type as string]?.[key]).join(", ");
      found.push(`"${typeof node.label === "string" ? node.label : id}" (${node.type}, ${where}) stores no ${defaults}`);
    }
  }
  return found;
}

const HOW_TO_FIX =
  "A control resets to the default it stores, and one that stores none cannot be reset (T1619b). In the document's source, " +
  "write the default beside the value it ships with (`value: 1, defaultValue: 1`; `on` with `defaultOn`; `x`, `y` with " +
  "`defaultX`, `defaultY`), then regenerate the file from its source; never edit the JSON.";

/** At most this many controls are spelled out per file. */
const SHOWN = 8;

function spelled(names: readonly string[]): string {
  const shown = names.slice(0, SHOWN).join("; ");
  return names.length > SHOWN ? `${shown}; and ${names.length - SHOWN} more` : shown;
}

/**
 * Every way the shipped set and the ledger can disagree, each as an instruction. A pure
 * function of (files, ledger) so the tests below can hand it a file with a known defect and a
 * ledger with a known lie: a gate only ever seen green has not been seen to work (§V245).
 */
function defaultProblems(files: readonly ShippedFile[], ledger: Readonly<Record<string, number>>): string[] {
  const problems: string[] = [];
  const present = new Set(files.map((file) => file.path));
  for (const file of files) {
    const owed = controlsWithoutDefault(file.text);
    const actual = owed.length;
    const listed = Object.hasOwn(ledger, file.path) ? ledger[file.path] : undefined;
    if (listed === undefined) {
      if (actual > 0) {
        problems.push(
          `${file.path} has ${actual} control(s) that store no default: ${spelled(owed)}. ${HOW_TO_FIX} ` +
            "This file is not in NO_DEFAULT_YET, and a new document does not go on it.",
        );
      }
      continue;
    }
    if (actual === 0) {
      problems.push(`${file.path} now stores every control's default (the ledger says ${listed}). Remove its line from NO_DEFAULT_YET in src/examples/control-defaults.test.ts.`);
    } else if (actual < listed) {
      problems.push(`${file.path} is down to ${actual} control(s) with no default (the ledger says ${listed}). Lower its line in NO_DEFAULT_YET to ${actual}.`);
    } else if (actual > listed) {
      problems.push(
        `${file.path} has ${actual} control(s) with no default, up from the ${listed} the ledger allows: a control with no default was ADDED to a listed file. Still owed: ${spelled(owed)}. ${HOW_TO_FIX}`,
      );
    }
  }
  for (const path of Object.keys(ledger).sort()) {
    if (!present.has(path)) problems.push(`NO_DEFAULT_YET lists ${path}, which is not a shipped file. Remove the line.`);
  }
  return problems;
}

describe("every shipped control stores its default (T1619b)", () => {
  it("reads real files that hold controls, or it is measuring nothing", () => {
    expect(SHIPPED.length).toBeGreaterThan(80);
    // E81 Phone Desk ships a Slider, a Toggle and an XY Pad, each with its default.
    const phoneDesk = SHIPPED.find((file) => file.path === "examples/E81-Phone-Desk.loom.json");
    expect(phoneDesk).toBeDefined();
    expect(controlsWithoutDefault(phoneDesk?.text ?? "{}")).toEqual([]);
    expect(Object.values((JSON.parse(phoneDesk?.text ?? "{}") as StoredFile).graph?.nodes ?? {}).filter((node) => CONTROL_DEFAULT_KEYS[String(node.type)] !== undefined)).toHaveLength(3);
  });

  it("no shipped example, starter component or project holds a control without a default, beyond the ledger's exact counts", () => {
    expect(defaultProblems(SHIPPED, NO_DEFAULT_YET)).toEqual([]);
  });
});

describe("the gate can fail, in every direction the ledger can lie", () => {
  const file = (nodes: Record<string, unknown>): string => JSON.stringify({ graph: { nodes } });
  const slider = (parameters: Record<string, unknown>): unknown => ({ type: "slider", label: "slider_heat", parameters });
  const clean = file({ a: slider({ value: 1, defaultValue: 1 }) });
  const owing = file({
    a: slider({ value: 1 }),
    b: { type: "xyPad", label: "xypad_aim", parameters: { x: 0.2, y: 0.8, defaultX: 0.2 } },
    c: { type: "button", label: "button_flash", parameters: { held: false } },
    d: { type: "toggle", label: "toggle_cut", parameters: { on: true, defaultOn: true } },
  });

  it("names a control that stores no default, per key, and passes over a Button and a control that stores one", () => {
    expect(controlsWithoutDefault(owing)).toEqual(['"slider_heat" (slider, root) stores no defaultValue', '"xypad_aim" (xyPad, root) stores no defaultY']);
    expect(controlsWithoutDefault(clean)).toEqual([]);
  });

  it("looks inside the components a file embeds", () => {
    const embedded = JSON.stringify({ graph: { nodes: {} }, componentLibrary: { components: [{ componentId: "cmp_1", graph: { nodes: { a: slider({ value: 1 }) } } }] } });
    expect(controlsWithoutDefault(embedded)).toEqual(['"slider_heat" (slider, component cmp_1) stores no defaultValue']);
  });

  it("fails an unlisted file that owes a default, and says how to fix it", () => {
    const problems = defaultProblems([{ path: "examples/E99-New.loom.json", text: owing }], {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("examples/E99-New.loom.json has 2 control(s) that store no default");
    expect(problems[0]).toContain("defaultValue: 1");
  });

  it("fails a listed file whose count went down, went up, or reached zero, and a line for a file that is gone", () => {
    const listed = [{ path: "projects/a/a.loom.json", text: owing }];
    expect(defaultProblems(listed, { "projects/a/a.loom.json": 2 })).toEqual([]);
    expect(defaultProblems(listed, { "projects/a/a.loom.json": 3 })[0]).toContain("Lower its line in NO_DEFAULT_YET to 2");
    expect(defaultProblems(listed, { "projects/a/a.loom.json": 1 })[0]).toContain("was ADDED to a listed file");
    expect(defaultProblems([{ path: "projects/a/a.loom.json", text: clean }], { "projects/a/a.loom.json": 2 })[0]).toContain("Remove its line");
    expect(defaultProblems([], { "projects/gone.loom.json": 1 })).toEqual(["NO_DEFAULT_YET lists projects/gone.loom.json, which is not a shipped file. Remove the line."]);
  });
});
