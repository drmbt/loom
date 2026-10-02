import { MORPH_CURVES, type MorphCurve, type MorphSpec } from "./bank.ts";

/**
 * T1500b (§T1398b S5, ruling 15) — THE CUE LIST'S DATA: what a `cueList` node holds in its
 * `cues` parameter, and where GO / BACK land in it.
 *
 * A cue list is ORDERED, STATEFUL sequencing ACROSS banks (the design doc §8.2): each cue
 * names one bank and one of its presets (a shot is just a preset in a shots bank), and the
 * list remembers where it is in two parameters, `current` and `standby`. Like the bank it
 * is a NODE whose data lives in PARAMETERS (ruling 1), so undo, autosave, copy/paste and
 * the agent's `get_graph` carry it with nothing built for them.
 *
 * This module is the headless half: the JSON shape, its parser, and the three questions
 * the commands ask of it — which cue does GO fire, which does BACK fire, and what stands
 * by after a cue has fired. They are PURE functions of (list, current, standby, wrap), so
 * every surface that shows "next" derives it exactly as GO does. What firing a cue DOES
 * is `cue-commands.ts`.
 *
 * A cue names its bank by node NAME, never id (§V129), and the rename clause for cue lists
 * (`names.ts`) keeps a rename and a paste renumbering pointed at the right bank (§V320).
 * `current` and `standby` hold CUE names, and a cue names its PRESET — neither is a node
 * name, so a node rename leaves all three alone.
 */

/** The node type every cue list is. Named once here; the definition and the rename clause read it. */
export const CUE_LIST_NODE_TYPE = "cueList";

/**
 * The two commands the list's own pulses fire. Named HERE rather than beside their
 * handlers (`cue-commands.ts`) because `commands.ts` lists them among the pulse commands a
 * render must not fire, and `cue-commands.ts` imports the recall planner from
 * `commands.ts` — a constant read at module scope across that cycle would be read before
 * it exists. This module imports neither.
 */
export const CUE_GO_COMMAND = "cue.go";
export const CUE_BACK_COMMAND = "cue.back";

export interface CueList {
  readonly version: 1;
  readonly cues: readonly Cue[];
}

export interface Cue {
  /** Unique in the list; shown as the cue number or label. */
  readonly name: string;
  /** A bank node NAME and one of its presets. A shot is just a preset in a shots bank. */
  readonly bank: string;
  readonly preset: string;
  /** Overrides the preset's and the bank's morph for this cue (the design doc §5.1). */
  readonly morph?: MorphSpec;
  /** Operator's note, shown on the Panel and the phone. */
  readonly note?: string;
}

/** The list as the `cues` parameter stores it. Two-space indent: it is hand-editable. */
export function serializeCueList(list: CueList): string {
  return `${JSON.stringify(list, null, 2)}\n`;
}

/** What a freshly dropped cue list holds: a well-formed list with nothing in it. */
export const EMPTY_CUE_LIST_JSON = serializeCueList({ version: 1, cues: [] });

export type CueListParse = { ok: true; list: CueList } | { ok: false; reason: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A cue name is free text ("1", "2a", "drop") — but it must be SOMETHING, and be spelled one way. */
function isCueName(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name === name.trim();
}

/**
 * Parses a list's JSON. Structure only: whether the named bank exists and holds the named
 * preset is GO's question, answered against the graph as it is then (ruling 4). Blank
 * text is an empty list, so clearing the field is not an error.
 *
 * The reason names the cue and the field, never quotes a value: cue text is document
 * content and a diagnostic is read by a model (§V37).
 */
export function parseCueList(text: unknown): CueListParse {
  if (typeof text !== "string" || text.trim() === "") return { ok: true, list: { version: 1, cues: [] } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the cues field is not valid JSON" };
  }
  if (!plainObject(raw)) return { ok: false, reason: "the cues field must be an object with version and cues" };
  if (raw["version"] !== 1) return { ok: false, reason: "the cues field has an unknown version (this build reads version 1)" };
  const entries = raw["cues"];
  if (!Array.isArray(entries)) return { ok: false, reason: "the cues field has no cues list" };
  const cues: Cue[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const parsed = parseCue(entry, index);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.cue.name)) return { ok: false, reason: `two cues are named "${parsed.cue.name}"` };
    seen.add(parsed.cue.name);
    cues.push(parsed.cue);
  }
  return { ok: true, list: { version: 1, cues } };
}

function parseCue(entry: unknown, index: number): { ok: true; cue: Cue } | { ok: false; reason: string } {
  if (!plainObject(entry)) return { ok: false, reason: `cue ${index + 1} is not an object` };
  const name = entry["name"];
  if (!isCueName(name)) {
    return { ok: false, reason: `cue ${index + 1} needs a name: text that is not empty and has no space at either end` };
  }
  const where = `cue "${name}"`;
  const bank = entry["bank"];
  const preset = entry["preset"];
  if (typeof bank !== "string" || bank === "") return { ok: false, reason: `${where}: bank must name a Presets node` };
  if (typeof preset !== "string" || preset === "") return { ok: false, reason: `${where}: preset must name one of that bank's presets` };
  let cue: Cue = { name, bank, preset };

  const morph = entry["morph"];
  if (morph !== undefined) {
    const seconds = plainObject(morph) ? morph["seconds"] : undefined;
    const curve = plainObject(morph) ? morph["curve"] : undefined;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || !MORPH_CURVES.includes(curve as MorphCurve)) {
      return { ok: false, reason: `${where}: morph must be { seconds ≥ 0, curve: ${MORPH_CURVES.join(" | ")} }` };
    }
    cue = { ...cue, morph: { seconds, curve: curve as MorphCurve } };
  }
  const note = entry["note"];
  if (note !== undefined) {
    if (typeof note !== "string") return { ok: false, reason: `${where}: note must be text` };
    cue = { ...cue, note };
  }
  return { ok: true, cue };
}

/** Where a list is: what its `current`, `standby` and `wrap` parameters resolve to. */
export interface CuePosition {
  /** The cue that fired last. Empty before the first GO. */
  readonly current: string;
  /** The cue GO fires next. Empty means the cue after `current`, or the first cue. */
  readonly standby: string;
  readonly wrap: boolean;
}

/** A cue to fire, or why there is none — a refusal the operator reads (the design doc §8.2). */
export type CuePick =
  | { readonly ok: true; readonly cue: Cue; readonly index: number }
  | { readonly ok: false; readonly code: string; readonly reason: string; readonly suggestion: string };

const SET_STANDBY = "Move the standby to the cue you want next.";

function refuse(code: string, reason: string, suggestion: string = SET_STANDBY): CuePick {
  return { ok: false, code, reason, suggestion };
}

/** A cue by name, or the refusal that says the list has none so named. */
export function cueNamed(list: CueList, name: string): CuePick {
  const index = list.cues.findIndex((cue) => cue.name === name);
  const cue = list.cues[index];
  if (cue === undefined) {
    const known = list.cues.map((each) => each.name).join(", ");
    return refuse("cue.unknown", `it has no cue "${name}"`, known === "" ? "The list is empty; add cues to its Cues field." : `Its cues: ${known}.`);
  }
  return { ok: true, cue, index };
}

/**
 * THE CUE GO FIRES — "next", which is always DERIVED and never a third stored field (the
 * design doc §8.2): `standby` when it names a cue, else the cue after `current`, else the
 * first cue.
 *
 * Three refusals, each leaving the list exactly where it is:
 *  - a `standby` or `current` that names no cue (it was deleted or retyped since). Falling
 *    back to the first cue would fire cue 1 in the middle of a show, on a GO meant for
 *    cue 8 — the one substitution a cue list must never make;
 *  - GO past the last cue with `wrap` off;
 *  - an empty list.
 */
export function standbyCue(list: CueList, position: CuePosition): CuePick {
  if (list.cues.length === 0) return refuse("cue.go.empty", "it has no cues", "Add cues to its Cues field.");
  if (position.standby !== "") {
    const named = cueNamed(list, position.standby);
    return named.ok ? named : refuse("cue.standby.unknown", `its standby names "${position.standby}", which is not one of its cues`);
  }
  if (position.current === "") return { ok: true, cue: list.cues[0] as Cue, index: 0 };
  const at = list.cues.findIndex((cue) => cue.name === position.current);
  if (at < 0) return refuse("cue.current.unknown", `its current cue "${position.current}" is no longer in the list, so there is no cue after it`);
  const after = cueAfter(list, at, position.wrap);
  if (after === undefined) {
    return refuse(
      "cue.go.end",
      `"${position.current}" is its last cue and Wrap is off`,
      "Turn Wrap on to go round to the first cue, or move the standby.",
    );
  }
  return { ok: true, cue: after, index: list.cues.indexOf(after) };
}

/**
 * THE CUE BACK FIRES: the one before `current` (owner's ruling: BACK FIRES it, with its own
 * morph — the live way to go back a look without reaching for undo). It does not read the
 * standby, and it does not wrap: `wrap` is about GO running off the END.
 */
export function previousCue(list: CueList, position: CuePosition): CuePick {
  if (list.cues.length === 0) return refuse("cue.go.empty", "it has no cues", "Add cues to its Cues field.");
  if (position.current === "") return refuse("cue.back.unfired", "nothing has fired yet, so there is no cue to go back to", "Press GO first.");
  const at = list.cues.findIndex((cue) => cue.name === position.current);
  if (at < 0) return refuse("cue.current.unknown", `its current cue "${position.current}" is no longer in the list, so there is no cue before it`);
  const before = list.cues[at - 1];
  if (before === undefined) return refuse("cue.back.start", `"${position.current}" is its first cue`, "There is nothing before it.");
  return { ok: true, cue: before, index: at - 1 };
}

/** What stands by once the cue at `index` has fired: the one after it, the first on a wrap, or none. */
export function cueAfter(list: CueList, index: number, wrap: boolean): Cue | undefined {
  return list.cues[index + 1] ?? (wrap ? list.cues[0] : undefined);
}

/** "Next" as every surface shows it: the cue a GO would fire now, or `null` when it would be refused. */
export function nextCueName(list: CueList, position: CuePosition): string | null {
  const pick = standbyCue(list, position);
  return pick.ok ? pick.cue.name : null;
}
