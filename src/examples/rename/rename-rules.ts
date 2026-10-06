import { conformsToKind, withKind } from "../../domain/graph/node-kinds.ts";

/**
 * HOW A SHIPPED NAME GETS ITS ROLE (T1593b phase 2a).
 *
 * Some 3,300 shipped nodes are named for a role alone (`dye1`, `lamp`, `pathx1`) and have
 * to become `kind_role`. This is the part of that which a rule can do. It is deliberately
 * dumb: it keeps the author's own word and removes only what the old naming habit added,
 * so `dye1` on a Feedback is `feedback_dye` and somebody who knew the example still knows
 * the node. Anything a rule cannot do well (a role that only repeats the kind, a single
 * letter left over) is not guessed at here. It is marked, and a person decides it
 * (`rename-judgements.ts`).
 *
 * Pure, and exact-tested: the map of every shipped name is generated from these.
 */

/** Which mechanical rule produced a role. */
export type MechanicalRule =
  /** The old habit: the label was the node's id plus `1`. The id is the author's word. */
  | "habit"
  /** A lone trailing `1` that no sibling numbers against: the same habit, with another id. */
  | "number"
  /** One of a numbered run (`soften1`, `soften2`): the number tells them apart and stays. */
  | "series"
  /** No number at all: the name is the role. */
  | "as-is";

export interface MechanicalRole {
  readonly role: string;
  readonly rule: MechanicalRule;
}

const TRAILING_DIGITS = /^(.*?)([0-9]+)$/;

/** An id as the habit spelled it into a label: lower case, its underscores gone. */
const spelled = (id: string): string => id.toLowerCase().replace(/_/g, "");

/**
 * The role a name already says, with the old numbering habit taken off.
 *
 * `siblings` is every OTHER name in the same scope: a trailing `1` is the habit unless a
 * sibling carries the same word with a different number, in which case it is a count.
 */
export function mechanicalRole(id: string, name: string, siblings: ReadonlySet<string>): MechanicalRole {
  const lower = name.toLowerCase();
  // `dye` → `dye1`; `streak0` → `streak01` (the `0` is the author's, the `1` is the habit);
  // `geo_car0` → `geocar01` (the builder dropped the underscore).
  if (lower === `${id.toLowerCase()}1` || lower === `${spelled(id)}1`) {
    // …unless the word runs on: `soften1` beside `soften2` is the first of two and keeps its number.
    const word = name.slice(0, -1);
    const run = [...siblings].some((other) => other.startsWith(word) && /^[0-9]+$/.test(other.slice(word.length)));
    return run ? { role: name, rule: "series" } : { role: word, rule: "habit" };
  }
  // `band109` → `band109x1`: the author put an `x` between the id's own digits and the habit's.
  if (/[0-9]$/.test(id) && lower === `${spelled(id)}x1`) return { role: name.slice(0, -2), rule: "habit" };
  const numbered = TRAILING_DIGITS.exec(name);
  if (numbered === null) return { role: name, rule: "as-is" };
  const [, stem = "", digits = ""] = numbered;
  if (stem === "") return { role: name, rule: "as-is" };
  const inSeries = [...siblings].some((other) => {
    const match = TRAILING_DIGITS.exec(other);
    return match !== null && match[1] === stem && match[2] !== digits;
  });
  if (inSeries) return { role: name, rule: "series" };
  return digits === "1" ? { role: stem, rule: "number" } : { role: name, rule: "series" };
}

/**
 * The words authors wrote INSIDE a role that only say the kind again.
 *
 * `wallgrid1` on a Grid is `grid_wall`, not `grid_wallgrid`; `out1` on an Output has no
 * role at all. This table is how that is noticed. Noticing is all it does: every name it
 * touches is listed in full for review, because whether `cam` in `seatcam` is the kind or
 * part of a word a person meant is not something a table knows.
 *
 * Keyed by KIND. Longest first within a kind, so `pointkernel` is tried before `kernel`.
 */
export const KIND_WORDS: Readonly<Record<string, readonly string[]>> = {
  add: ["add"],
  audiofile: ["audiofilein"],
  beat: ["beat"],
  blur: ["blur"],
  camera: ["camera", "cam"],
  checker: ["checker"],
  cross: ["cross"],
  depth: ["depth"],
  feedback: ["feedback"],
  filmgrade: ["filmgrade", "grade"],
  flare: ["flare"],
  generator: ["pointgenerator", "generator", "gen"],
  geometry: ["geometry", "geo"],
  grid: ["points", "grid", "pts"],
  hsv: ["hsv"],
  instances: ["instances"],
  kernel: ["pointkernel", "kernel"],
  lag: ["lag"],
  lens: ["lens"],
  level: ["level", "lvl"],
  lfo: ["lfo"],
  light: ["light"],
  limit: ["limit", "lim"],
  lookup: ["lookup"],
  mask: ["mask"],
  material: ["material", "mat"],
  matte: ["matte"],
  mesh: ["mesh"],
  mouse: ["mouse"],
  movie: ["movie"],
  multiply: ["multiply", "mul"],
  noise: ["noise"],
  note: ["note"],
  null: ["null"],
  output: ["output", "out"],
  over: ["over"],
  panel: ["panel"],
  points: ["renderpoints", "points"],
  pose: ["pose"],
  projector: ["projector", "proj"],
  ramp: ["ramp"],
  range: ["range"],
  render: ["render"],
  screen: ["screen"],
  screenin: ["screenin"],
  select: ["select", "sel"],
  slitscan: ["slitscan"],
  sphere: ["sphere"],
  step: ["step"],
  streak: ["streak"],
  switch: ["switch", "sw"],
  tail: ["tail"],
  topology: ["topology"],
  torus: ["torus"],
  transform: ["transform", "xform"],
  trigger: ["trigger", "trig"],
  webcam: ["webcam", "camera", "cam"],
};

export interface Restated {
  /** What is left of the role with the kind's word taken off. Empty when nothing is. */
  readonly rest: string;
  /** The word that was found, and where. */
  readonly word: string;
  readonly at: "whole" | "prefix" | "suffix";
}

/**
 * Does this role say its kind again? `null` when it does not.
 *
 * Two ways to: one of the kind's listed words at either end of the role, or the role being
 * a piece of the kind's own word (`analysis` on an `audioanalysis`, `echo` on a
 * `feedbackecho`), which is how a component instance restates the component.
 */
export function restatedKind(role: string, kind: string): Restated | null {
  const lower = role.toLowerCase();
  for (const word of [...(KIND_WORDS[kind] ?? []), kind]) {
    if (lower === word) return { rest: "", word, at: "whole" };
    if (lower.startsWith(word) && lower.length > word.length) return { rest: joint(role.slice(word.length)), word, at: "prefix" };
    if (lower.endsWith(word) && lower.length > word.length) return { rest: trimmed(role.slice(0, -word.length)), word, at: "suffix" };
  }
  if (lower.length >= 3 && kind.includes(lower)) return { rest: "", word: lower, at: "whole" };
  return null;
}

const trimmed = (text: string): string => text.replace(/^_+|_+$/g, "");

/**
 * What followed a kind's word, once the word is gone. `noteBanks` leaves `Banks`, whose
 * capital was camelCase's joint and has nothing left to join: `note_banks`. A capital that
 * is a name of its own (`camA`, `projL`) is left for a person.
 */
function joint(rest: string): string {
  const text = trimmed(rest);
  return /^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/**
 * Is this role too thin to be left to a rule? One or two characters, or only digits:
 * `lag_s`, `limit_c`, `step_p`. Technically a name, and nobody can read it.
 */
export function thinRole(role: string): boolean {
  return role.length <= 2 || /^[0-9_]+$/.test(role);
}

/**
 * `kind_role`; or, when there is no role, the kind and a number, which is what auto-naming
 * would have given the node. A role that is only a number IS that number (`renderpoints2`
 * is `points2`). Never a name that does not conform.
 */
export function nameFor(kind: string, role: string, ordinal: number): string {
  const name = role === "" ? `${kind}${String(ordinal)}` : /^[0-9]+$/.test(role) ? `${kind}${role}` : withKind(kind, role);
  if (!conformsToKind(name, kind)) throw new Error(`nameFor("${kind}", "${role}"): "${name}" is not a name of that kind.`);
  return name;
}
